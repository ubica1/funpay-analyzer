import { fetchListing, collectionError } from "./http.mjs";
import { selectedCategoryIds, platforms } from "./platforms.mjs";
import { fetchExternalCategory } from "./external-collector.mjs";
import { load } from "cheerio";
import { saveSnapshot, settings } from "./db.mjs";
export function categoryUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "funpay.com" ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/(?:en\/)?lots\/\d+\/$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error("Нужна ссылка вида https://funpay.com/lots/81/");
  return `https://funpay.com/lots/${url.pathname.split("/").filter(Boolean).at(-1)}/`;
}
export function parseOffers(html, pageUrl) {
  const $ = load(html);
  const offers = [];
  let skipped = 0;
  if (/captcha|access denied|just a moment/i.test($("title").text()))
    throw new Error(
      "FunPay ограничил доступ. Попытка остановлена, обход защиты не выполняется.",
    );
  $("a.tc-item").each((i, node) => {
    const el = $(node);
    const rawUrl = el.attr("href");
    let url;
    try {
      url = new URL(rawUrl, pageUrl);
    } catch {
      skipped++;
      return;
    }
    const id = url.searchParams.get("id");
    const priceEl = el.find(".tc-price");
    const unit = priceEl.find(".unit").text().trim();
    const price = Number(
      priceEl.attr("data-s") ??
        priceEl
          .clone()
          .children(".unit")
          .remove()
          .end()
          .text()
          .replace(/[^\d.,]/g, "")
          .replace(",", "."),
    );
    const title = el.find(".tc-desc-text").text().trim();
    const seller = el.find(".media-user-name").text().trim();
    const sellerLink =
      el.find('[data-href*="/users/"]').attr("data-href") ??
      el.find('a[href*="/users/"]').attr("href");
    const sellerId = sellerLink?.match(/\/users\/(\d+)/)?.[1] ?? seller;
    if (
      !id ||
      url.hostname !== "funpay.com" ||
      !/^\d+$/.test(id) ||
      !Number.isFinite(price) ||
      price < 0 ||
      !title ||
      !seller ||
      !/₽|руб|RUB/i.test(unit)
    ) {
      skipped++;
      return;
    }
    const attributes = { auto: el.attr("data-auto") === "1" ? "1" : "0" };
    for (const [key, value] of Object.entries(node.attribs ?? {}))
      if (key.startsWith("data-f-")) attributes[key.slice(7)] = value;
    offers.push({
      id,
      title,
      price: Math.round(price * 100) / 100,
      seller,
      sellerId,
      reviews:
        Number(el.find(".rating-mini-count").text().replace(/\D/g, "")) || 0,
      online: el.attr("data-online") === "1",
      attributes,
      url: `https://funpay.com/lots/offer?id=${id}`,
    });
  });
  const count = $(".counter-item.active .counter-value")
    .first()
    .text()
    .replace(/\D/g, "");
  if (!offers.length)
    throw new Error(
      "Не найдены объявления в рублях. Возможна смена разметки, валюта или ограничение доступа.",
    );
  // Pinned offers may be repeated in the same HTML response.
  const unique = [
    ...new Map(offers.map((offer) => [offer.id, offer])).values(),
  ];
  return { offers: unique, advertised: count ? Number(count) : null, skipped };
}
export async function fetchCategory(url) {
  const response = await fetchListing(categoryUrl(url), {
    redirect: "error",
    headers: {
      "User-Agent": "FunPayMarketAnalyzer/0.1 (public listing statistics)",
      "Accept-Language": "ru-RU,ru;q=0.9",
      // FunPay picks the currency by location; ask for roubles explicitly.
      Cookie: "cy=rub",
    },
  });
  if (!response.ok)
    throw new Error(
      `FunPay HTTP ${response.status}. Следующая попытка по расписанию.`,
    );
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 20 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Страница превышает лимит 20 МБ.");
    }
    chunks.push(value);
  }
  return parseOffers(Buffer.concat(chunks).toString("utf8"), url);
}
// Opens the page of each vanished lot: FunPay answers 404 for a removed lot
// and shows the order form for a live one that was just not listed.
export async function checkOffer(offerId) {
  if (!/^\d+$/.test(offerId)) throw new Error("Неверный номер лота");
  const response = await fetch(`https://funpay.com/lots/offer?id=${offerId}`, {
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      "User-Agent": "FunPayMarketAnalyzer/0.1 (public listing statistics)",
      "Accept-Language": "ru-RU,ru;q=0.9",
      Cookie: "cy=rub",
    },
  });
  if (response.status === 404) return "removed";
  if (!response.ok) throw new Error(`FunPay HTTP ${response.status}`);
  const title = load(await response.text())("title").text();
  if (/captcha|access denied|just a moment/i.test(title))
    throw Object.assign(new Error("FunPay ограничил доступ"), {
      blocked: true,
    });
  return /не найдено/i.test(title) ? "removed" : "alive";
}
export async function verifySales(
  db,
  {
    check = checkOffer,
    limit = 20,
    pause = 1000,
    stopped = () => false,
    budgetMs = 30000,
  } = {},
) {
  const pending = db
    .prepare(
      "SELECT DISTINCT offer_id FROM sales WHERE verified IS NULL AND attempts<3 ORDER BY snapshot_id DESC LIMIT ?",
    )
    .all(limit);
  const deadline = Date.now() + budgetMs;
  let removed = 0;
  let alive = 0;
  for (
    let i = 0;
    i < pending.length && !stopped() && Date.now() < deadline;
    i++
  ) {
    const { offer_id } = pending[i];
    try {
      if ((await check(offer_id)) === "removed") {
        db.prepare(
          "UPDATE sales SET verified=1 WHERE offer_id=? AND verified IS NULL",
        ).run(offer_id);
        removed++;
      } else {
        db.prepare(
          "DELETE FROM sales WHERE offer_id=? AND verified IS NULL",
        ).run(offer_id);
        alive++;
      }
    } catch (e) {
      db.prepare(
        "UPDATE sales SET attempts=attempts+1 WHERE offer_id=? AND verified IS NULL",
      ).run(offer_id);
      if (e.blocked) break;
    }
    if (pause && i < pending.length - 1)
      await new Promise((resolve) => setTimeout(resolve, pause));
  }
  return {
    checked: removed + alive,
    removed,
    alive,
    left: pending.length - removed - alive,
  };
}
export function createCollector(
  db,
  {
    fetchPublic = fetchCategory,
    fetchExternal = fetchExternalCategory,
    verify = verifySales,
    pauseMs = 5000,
  } = {},
) {
  let running = false;
  let verifying = false;
  let progress = { completed: 0, total: 0, current: [] };
  let verificationTask = null;
  let nextAt = null;
  let timer;
  let lastCollection = null;
  let sequence = 0;
  let stopped = false;
  const log = (category, status, message, count = 0) =>
    db
      .prepare(
        "INSERT INTO runs(started_at,category_id,status,message,count) VALUES(?,?,?,?,?)",
      )
      .run(new Date().toISOString(), category, status, message, count);
  function plan() {
    clearTimeout(timer);
    nextAt = null;
    if (stopped || !settings(db).scheduled) return;
    nextAt = new Date(
      Date.now() + settings(db).intervalMinutes * 60000,
    ).toISOString();
    timer = setTimeout(
      () => collect().catch((e) => log(null, "error", e.message)),
      settings(db).intervalMinutes * 60000,
    );
    timer.unref();
  }
  async function collect(scope = {}) {
    if (running) return false;
    running = true;
    clearTimeout(timer);
    nextAt = null;
    try {
      const selected = scope.market
        ? new Set(
            selectedCategoryIds(db, {
              market: scope.market,
              category: scope.category ?? "all",
            }),
          )
        : null;
      const cats = db
        .prepare("SELECT * FROM categories WHERE enabled=1")
        .all()
        .filter(
          (c) =>
            (!selected || selected.has(c.id)) &&
            platforms.some((p) => p.id === c.platform && p.automatic !== false),
        );
      progress = { completed: 0, total: cats.length, current: [] };
      lastCollection = {
        id: ++sequence,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        results: [],
      };
      const groups = new Map();
      for (const c of cats) {
        if (!groups.has(c.platform)) groups.set(c.platform, []);
        groups.get(c.platform).push(c);
      }
      // Different hosts proceed independently. Keep the existing delay between
      // categories of the same host; snapshot writes are synchronous/atomic.
      await Promise.all(
        [...groups.values()].map(async (group) => {
          for (let i = 0; i < group.length && !stopped; i++) {
            const c = group[i];
            progress.current.push(c.name);
            try {
              const result =
                c.platform === "funpay"
                  ? await fetchPublic(c.url)
                  : await fetchExternal(c);
              saveSnapshot(db, c.id, result.offers, result);
              lastCollection.results.push({
                categoryId: c.id,
                name: c.name,
                status: "success",
                count: result.offers.length,
              });
              log(
                c.id,
                "success",
                result.advertised > result.offers.length
                  ? "Снимок сохранён; выборка неполная"
                  : "Снимок сохранён",
                result.offers.length,
              );
            } catch (e) {
              const message = collectionError(e);
              log(c.id, "error", message);
              lastCollection.results.push({
                categoryId: c.id,
                name: c.name,
                status: "error",
                message,
              });
            } finally {
              progress.completed++;
              progress.current = progress.current.filter(
                (name) => name !== c.name,
              );
            }
            if (i < group.length - 1 && !stopped && pauseMs)
              await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
        }),
      );
      // Verifying removed FunPay lots must not hold up fresh market snapshots.
      // Run one bounded batch; another collection never starts a second verifier.
      if (
        !stopped &&
        !verifying &&
        cats.some(
          (c) =>
            c.platform === "funpay" &&
            lastCollection.results.some(
              (r) => r.categoryId === c.id && r.status === "success",
            ),
        )
      ) {
        verifying = true;
        verificationTask = Promise.resolve()
          .then(() => verify(db, { stopped: () => stopped }))
          .then((result) => {
            if (result.checked || result.left)
              log(
                null,
                result.left ? "warning" : "success",
                `Фоновая проверка лотов: удалено ${result.removed}, ещё продаются ${result.alive}, осталось в партии ${result.left}`,
                result.removed,
              );
          })
          .catch((e) => log(null, "error", e.message))
          .finally(() => {
            verifying = false;
            verificationTask = null;
          });
      }
      const cutoff = new Date(
        Date.now() - settings(db).retentionDays * 86400000,
      ).toISOString();
      db.prepare("DELETE FROM snapshots WHERE collected_at<?").run(cutoff);
      db.prepare("DELETE FROM runs WHERE started_at<?").run(cutoff);
      db.exec("PRAGMA incremental_vacuum;");
    } finally {
      if (lastCollection) lastCollection.finishedAt = new Date().toISOString();
      running = false;
      plan();
    }
    return true;
  }
  return {
    collect,
    plan,
    status: () => ({ running, nextAt, verifying, ...progress, lastCollection }),
    settled: async () => {
      if (verificationTask) await verificationTask;
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
