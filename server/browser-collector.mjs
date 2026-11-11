import { chromium } from "playwright-core";
import { platforms } from "./platforms.mjs";
import { upstreamError } from "./http.mjs";

let browserPromise;
let idleTimer;
let active = 0;
const waiters = [];
async function acquire() {
  if (active >= 2) await new Promise((resolve) => waiters.push(resolve));
  active++;
}
function release() {
  active--;
  waiters.shift()?.();
}
async function browser() {
  clearTimeout(idleTimer);
  if (!browserPromise)
    browserPromise = (async () => {
      if (process.env.BROWSER_EXECUTABLE_PATH)
        return chromium.launch({
          executablePath: process.env.BROWSER_EXECUTABLE_PATH,
          headless: true,
        });
      // Local macOS/Windows can use installed Chrome; container uses Playwright Chromium.
      if (process.platform === "darwin" || process.platform === "win32")
        return chromium.launch({
          channel: process.env.BROWSER_CHANNEL ?? "chrome",
          headless: true,
        });
      return chromium.launch({ headless: true });
    })().catch((error) => {
      browserPromise = null;
      throw new Error(
        `Не удалось запустить браузер для сбора. Установите Chrome или Chromium. ${error.message.split("\n")[0]}`,
      );
    });
  return browserPromise;
}
export async function closeCollectionBrowser() {
  clearTimeout(idleTimer);
  const current = browserPromise;
  browserPromise = null;
  if (current) await (await current).close().catch(() => {});
}
const ready = {
  playerok: 'a[href*="/products/"]',
  eldorado: 'a[href*="/oa/"]',
  g2g: 'a[href*="/offer/"]',
  ggsel: 'a[href*="/catalog/product/"]',
  plati: "a[product_id]",
  z2u: ".productCardStyle-2",
  playerauctions: 'a[href*="/dota-2-account/"][href*="a!"]',
};
export async function renderCategory(platformId) {
  const p = platforms.find((p) => p.id === platformId && p.id !== "funpay");
  if (!p) throw new Error("Неизвестная площадка");
  await acquire();
  let context;
  let step = "открытие каталога";
  try {
    const instance = await browser();
    context = await instance.newContext({
      locale: p.region === "ru" ? "ru-RU" : "en-US",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      ["image", "media", "font"].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
    const response = await page.goto(p.url, {
      waitUntil: "commit",
      timeout: 25000,
    });
    if (response && response.status() >= 400)
      throw upstreamError(p.name, response.status());
    // Wait for actual listing links rather than networkidle: marketplaces
    // commonly keep analytics connections open indefinitely.
    step = "загрузка карточек";
    await page
      .locator(ready[platformId])
      .first()
      .waitFor({ state: "attached", timeout: 25000 });
    step = "выбор валюты";
    if (
      platformId === "eldorado" &&
      !/USD/.test(
        await page
          .locator(".locale-currency-button")
          .innerText({ timeout: 10000 }),
      )
    ) {
      await page.locator(".locale-currency-button").click();
      await page
        .locator('[formcontrolname="currencyPreference"] [role="combobox"]')
        .click();
      await page
        .getByRole("option")
        .filter({ hasText: /^USD/ })
        .click({ timeout: 5000 });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForFunction(
        () =>
          /^\s*(?:\$|USD)/.test(
            document.querySelector('[aria-label="amount-price"]')
              ?.textContent ?? "",
          ),
        undefined,
        { timeout: 10000 },
      );
    }
    return await page.content();
  } catch (error) {
    if (error.name === "TimeoutError") {
      const title = await context
        ?.pages()[0]
        ?.title()
        .catch(() => "");
      if (
        /captcha|just a moment|access denied|attention required/i.test(
          title ?? "",
        )
      )
        throw new Error(`${p.name}: площадка запросила проверку браузера.`);
      throw Object.assign(
        new Error(
          `${p.name}: истекло время ожидания (${step}). Новый снимок не сохранён.`,
        ),
        { retryable: true },
      );
    }
    throw error;
  } finally {
    await context?.close().catch(() => {});
    release();
    if (!active) {
      idleTimer = setTimeout(
        () => closeCollectionBrowser().catch(() => {}),
        15000,
      );
      idleTimer.unref();
    }
  }
}
