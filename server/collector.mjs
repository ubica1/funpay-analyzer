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
  const response = await fetch(categoryUrl(url), {
    redirect: "error",
    signal: AbortSignal.timeout(45000),
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
export function createCollector(db) {
  let running = false;
  let nextAt = null;
  let timer;
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
  async function collect() {
    if (running) return false;
    running = true;
    clearTimeout(timer);
    nextAt = null;
    try {
      const cats = db.prepare("SELECT * FROM categories WHERE enabled=1").all();
      for (let i = 0; i < cats.length && !stopped; i++) {
        const c = cats[i];
        try {
          const result = await fetchCategory(c.url);
          saveSnapshot(db, c.id, result.offers, result);
          log(
            c.id,
            "success",
            result.advertised > result.offers.length
              ? "Снимок сохранён; выборка неполная"
              : "Снимок сохранён",
            result.offers.length,
          );
        } catch (e) {
          log(c.id, "error", e.message);
        }
        if (i < cats.length - 1)
          await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      const cutoff = new Date(
        Date.now() - settings(db).retentionDays * 86400000,
      ).toISOString();
      db.prepare("DELETE FROM snapshots WHERE collected_at<?").run(cutoff);
      db.prepare("DELETE FROM runs WHERE started_at<?").run(cutoff);
      db.exec("PRAGMA incremental_vacuum;");
    } finally {
      running = false;
      plan();
    }
    return true;
  }
  return {
    collect,
    plan,
    status: () => ({ running, nextAt }),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
