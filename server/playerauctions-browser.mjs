import { chromium } from "playwright-core";
import { load } from "cheerio";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { playerauctionsAccountAttributes } from "./playerauctions-fields.mjs";
import { upstreamError } from "./http.mjs";

export const playerauctionsCatalog =
  "https://www.playerauctions.com/dota-2-account/";
export function playerauctionsPageInfo(html, url) {
  const $ = load(html);
  if (/just a moment|captcha|access denied/i.test($("title").text()))
    throw new Error(
      "PlayerAuctions: площадка запросила проверку браузера. Полный снимок не сохранён.",
    );
  const raw = $(".offer-search-count")
    .first()
    .text()
    .match(/([\d,\s]+)\s*Offers found/i)?.[1];
  const total = raw == null ? NaN : Number(raw.replace(/\D/g, ""));
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error(
      "PlayerAuctions: не удалось определить число объявлений. Полнота снимка не подтверждена.",
    );
  const current = Number(new URL(url).searchParams.get("PageIndex") || 1);
  const anchor = $('.pagination a[aria-label="Next Page"]').first();
  let next = null;
  if (anchor.length && !anchor.parent().hasClass("disabled")) {
    const candidate = new URL(anchor.attr("href") || url, url);
    const index = Number(candidate.searchParams.get("PageIndex") || 1);
    if (
      candidate.origin !== new URL(playerauctionsCatalog).origin ||
      candidate.pathname !== "/dota-2-account/" ||
      [...candidate.searchParams].some(
        ([key, value]) =>
          key !== "PageIndex" &&
          !(["Serverid", "Isdelivery"].includes(key) && value === "0"),
      ) ||
      !Number.isSafeInteger(index)
    )
      throw new Error("PlayerAuctions: неверный адрес следующей страницы.");
    if (index > current) next = candidate.href;
  }
  return { total, next };
}
export function playerauctionsDescriptionEvidence(html) {
  const $ = load(html);
  let content = $("#offer-description-section .description-content").clone();
  if (!content.length) content = $("#offer-description-section").clone();
  const embedded = content
    .find("iframe[srcdoc]")
    .map((_, e) => $(e).attr("srcdoc"))
    .get()
    .join("\n");
  if (embedded)
    content = load("<section>" + content.html() + embedded + "</section>")(
      "section",
    );
  content.find("script,style").remove();
  const atoms = content
    .find("*")
    .filter((_, e) => !$(e).children().length)
    .map((_, e) => $(e).text().replace(/\s+/g, " ").trim())
    .get();
  content.find("br").replaceWith("\n");
  content.find("div,p,tr,td,th,section,li,h1,h2,h3").append("\n");
  const text = content.text();
  const lines = [...text.split("\n"), ...atoms]
    .map((s) => s.trim())
    .filter(Boolean);
  const evidence = new Set();
  const label =
    /^(MMR|RANK|BEHAVIOR(?: SCORE)?|BEHAVIOUR(?: SCORE)?|DECENCY|COMMUNICATION SCORE)\s*[:=-]?$/i;
  for (let i = 0; i < lines.length; i++) {
    if (label.test(lines[i]) && lines[i + 1])
      evidence.add(lines[i].replace(/\s*[:=-]?$/, "") + ": " + lines[i + 1]);
    if (
      /^(?:MMR|RANK|BEHAVIOR(?: SCORE)?|BEHAVIOUR(?: SCORE)?|DECENCY|COMMUNICATION SCORE)\s*:\s*\S+/i.test(
        lines[i],
      )
    )
      evidence.add(lines[i]);
  }
  if (/\b(?:ranked|rank)[ -]?ready\b/i.test(text)) evidence.add("Ranked Ready");
  if (
    /(?:not|non)[ -]?(?:ranked|rank)[ -]?ready|rank(?:ed)?[ -]?(?:locked|not ready)/i.test(
      text,
    )
  )
    evidence.add("Ranked Locked");
  return [...evidence].join("\n");
}
export async function collectPlayerauctionsPages({
  loadPage,
  parsePage,
  onProgress = () => {},
  readDescription,
  maxPages = 500,
  onCatalogComplete = async () => {},
  maxDetailMs = 300000,
  maxConsecutiveDetailFailures = 3,
  now = Date.now,
}) {
  const offers = new Map(),
    visited = new Set();
  let url = playerauctionsCatalog,
    expected = null;
  while (url) {
    if (visited.has(url) || visited.size >= maxPages)
      throw new Error(
        "PlayerAuctions: повтор страницы или превышен лимит. Неполный снимок не сохранён.",
      );
    visited.add(url);
    const html = await loadPage(url),
      info = playerauctionsPageInfo(html, url);
    if (expected == null) expected = info.total;
    if (expected !== info.total)
      throw Object.assign(
        new Error(
          "PlayerAuctions: каталог изменился во время обхода. Полный снимок нужно собрать повторно.",
        ),
        { retryable: true },
      );
    if (expected === 0)
      throw new Error(
        "PlayerAuctions: каталог пуст. Предыдущий снимок сохранён.",
      );
    const page = parsePage(html);
    const previousSize = offers.size;
    for (const offer of page.offers) offers.set(offer.id, offer);
    if (offers.size === previousSize)
      throw new Error(
        "PlayerAuctions: следующая страница повторяет предыдущую. Неполный снимок не сохранён.",
      );
    onProgress({
      stage: "catalog",
      completed: offers.size,
      total: expected,
      page: visited.size,
    });
    url = info.next;
  }
  if (offers.size !== expected)
    throw new Error(
      `PlayerAuctions: собрано ${offers.size} из ${expected}. Неполный снимок не сохранён.`,
    );
  await onCatalogComplete();
  let detailsFailed = 0;
  if (readDescription) {
    const entries = [...offers.values()];
    const started = now();
    let completed = 0,
      consecutiveFailures = 0;
    for (const offer of entries) {
      if (
        now() - started >= maxDetailMs ||
        consecutiveFailures >= maxConsecutiveDetailFailures
      )
        break;
      try {
        const html = await readDescription(offer.url);
        if (!load(html)("#offer-description-section").length)
          throw new Error("Описание объявления не загрузилось");
        const evidence = playerauctionsDescriptionEvidence(html);
        offer.attributes = {
          ...offer.attributes,
          ...playerauctionsAccountAttributes(
            offer.title,
            evidence,
            offer.attributes.auto === "1",
          ),
        };
        consecutiveFailures = 0;
      } catch {
        detailsFailed++;
        consecutiveFailures++;
      } finally {
        onProgress({
          stage: "details",
          completed: ++completed,
          total: entries.length,
        });
      }
    }
    // The catalog is already complete. Unavailable optional descriptions must
    // not prevent fresh listings from being saved or consume a small VPS all day.
    detailsFailed += entries.length - completed;
  }
  return {
    offers: [...offers.values()],
    advertised: expected,
    skipped: 0,
    pages: visited.size,
    detailsFailed,
  };
}
export async function readPlayerauctionsPage(
  page,
  url,
  { followNext = false } = {},
) {
  let response;
  if (followNext) {
    // Numbered links reuse aria-labels when the visible page window shifts.
    // The dedicated next-page control keeps the correct destination.
    const link = page.locator('.pagination a[aria-label="Next Page"]').first();
    [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "commit", timeout: 20000 }),
      link.click({ timeout: 10000 }),
    ]);
  } else {
    response = await page.goto(url, { waitUntil: "commit", timeout: 20000 });
  }
  if (!response) throw new Error("PlayerAuctions: браузер не получил ответ.");
  if (response.status() >= 400 && ![403, 429].includes(response.status()))
    throw upstreamError("PlayerAuctions", response.status());
  const catalog = new URL(url).pathname === "/dota-2-account/";
  try {
    // The server response has cards but no pagination. The site's own scripts
    // create page links and description content after parsing the document.
    if (!catalog)
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    await page
      .locator(catalog ? ".offer-item" : "#offer-description-section")
      .first()
      .waitFor({ state: "attached", timeout: 30000 });
  } catch {
    if (
      response.status() >= 400 ||
      /captcha|just a moment|access denied/i.test(await page.title())
    )
      throw new Error(
        "PlayerAuctions: требуется ручная проверка браузера. Полный снимок не сохранён.",
      );
    throw Object.assign(
      new Error(
        "PlayerAuctions: страница не загрузилась полностью. Новый снимок не сохранён.",
      ),
      { retryable: true },
    );
  }
  if (catalog) {
    const expectedPage = Number(
      new URL(url).searchParams.get("PageIndex") || 1,
    );
    const actualPage = Number(
      new URL(page.url()).searchParams.get("PageIndex") || 1,
    );
    if (actualPage !== expectedPage)
      throw new Error(
        `PlayerAuctions: вместо страницы ${expectedPage} открылась ${actualPage}. Неполный снимок не сохранён.`,
      );
    const $ = load(await page.content());
    const total = Number(
      $(".offer-search-count")
        .first()
        .text()
        .match(/([\d,\s]+)\s*Offers found/i)?.[1]
        ?.replace(/\D/g, ""),
    );
    if (total > $(".offer-item").length)
      await page
        .locator('.pagination a[aria-label="Next Page"]')
        .first()
        .waitFor({ state: "attached", timeout: 10000 });
  }
  return page.content();
}
async function virtualDisplay() {
  const child = spawn(
    "Xvfb",
    [
      "-displayfd",
      "3",
      "-screen",
      "0",
      "1366x900x24",
      "-nolisten",
      "tcp",
      "-noreset",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe"] },
  );
  let timer;
  try {
    const number = await new Promise((accept, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(
              new Error("Не удалось запустить экран браузера PlayerAuctions."),
              { retryable: true },
            ),
          ),
        15000,
      );
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("Экран браузера PlayerAuctions завершился.")),
      );
      child.stdio[3].once("data", (b) =>
        /^\d+\s*$/.test(b.toString())
          ? accept(b.toString().trim())
          : reject(new Error("Неверный номер экрана браузера.")),
      );
    });
    return { display: ":" + number, close: () => child.kill("SIGTERM") };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function fetchPlayerauctionsBrowser({
  parsePage,
  onProgress,
  profileDir = resolve(
    dirname(process.env.DATABASE_PATH || "data/market.sqlite"),
    "browsers/playerauctions",
  ),
  proxy = process.env.PLAYERAUCTIONS_PROXY_URL,
} = {}) {
  let display, context;
  try {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const headless = process.env.PLAYERAUCTIONS_HEADLESS
      ? process.env.PLAYERAUCTIONS_HEADLESS === "true"
      : process.platform !== "linux";
    if (!headless && !process.env.DISPLAY) display = await virtualDisplay();
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      ...(process.platform === "darwin"
        ? { channel: process.env.BROWSER_CHANNEL || "chrome" }
        : {}),
      ...(display ? { env: { ...process.env, DISPLAY: display.display } } : {}),
      ...(proxy ? { proxy: { server: proxy } } : {}),
      args: ["--disable-http2", "--disable-quic"],
    });
    await context.route("**/*", (r) =>
      ["image", "media", "font"].includes(r.request().resourceType())
        ? r.abort()
        : r.continue(),
    );
    const main = context.pages()[0] || (await context.newPage());
    let detailPage;
    return await collectPlayerauctionsPages({
      loadPage: (url) =>
        readPlayerauctionsPage(main, url, {
          followNext: url !== playerauctionsCatalog,
        }),
      parsePage,
      onProgress,
      onCatalogComplete: async () => {
        detailPage = await context.newPage();
        await main.close();
      },
      readDescription: (url) => readPlayerauctionsPage(detailPage, url),
    });
  } finally {
    await context?.close().catch(() => {});
    display?.close();
  }
}
