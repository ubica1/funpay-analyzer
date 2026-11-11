import { playerauctionsAccountAttributes } from "./playerauctions-fields.mjs";
import { fetchPlayerauctionsBrowser } from "./playerauctions-browser.mjs";
import { fetchPlayerokCategory } from "./playerok-collector.mjs";
import { g2gRankProperties } from "./g2g-fields.mjs";
import {
  renderCategory,
  closeCollectionBrowser,
} from "./browser-collector.mjs";
import { fetchListing, retrySnapshot, upstreamError } from "./http.mjs";
import { externalAttributes } from "./external-fields.mjs";
import { load } from "cheerio";
import { platforms } from "./platforms.mjs";

const amount = (value) => {
  const text = String(value ?? "").replace(/[\s\u00a0]/g, "");
  const match = text.match(/\d[\d,]*(?:\.\d+)?/);
  return match
    ? Number(
        match[0].includes(".")
          ? match[0].replaceAll(",", "")
          : match[0].replace(",", "."),
      )
    : NaN;
};
// Accept individual listings only. AggregateOffer describes the category,
// and must never become a fabricated listing at its minimum price.
export function parseExternalOffers(html, platformId) {
  const p = platforms.find((p) => p.id === platformId && p.id !== "funpay");
  if (!p) throw new Error("Неизвестная площадка");
  const $ = load(html);
  if (
    /captcha|access denied|just a moment|attention required/i.test(
      $("title").text(),
    )
  )
    throw new Error(`${p.name}: доступ ограничен. Снимок не сохранён.`);
  const offers = new Map();
  let skipped = 0;
  function add({
    url,
    title,
    price,
    currency,
    seller,
    sellerId,
    reviews = 0,
    online,
    properties = [],
    instant = false,
  }) {
    let link;
    try {
      link = new URL(url, p.url);
    } catch {
      skipped++;
      return;
    }
    const origin = new URL(p.url);
    if (
      !url ||
      link.protocol !== "https:" ||
      link.hostname !== origin.hostname ||
      link.username ||
      link.password ||
      link.port ||
      link.pathname === origin.pathname ||
      !title ||
      !Number.isFinite(price) ||
      price < 0 ||
      currency !== p.currency
    ) {
      skipped++;
      return;
    }
    // Plati's game page also contains skins and subscriptions.
    if (p.id === "plati" && !/аккаунт|account|\bmmr\b|ммр/i.test(title)) return;
    const paId =
      p.id === "playerauctions"
        ? link.pathname.match(/^\/dota-2-account\/(\d+)a!/)?.[1]
        : null;
    if (p.id === "playerauctions" && !paId) {
      skipped++;
      return;
    }
    const id = paId
      ? `playerauctions:${paId}`
      : `${p.id}:${link.pathname.replace(/\/$/, "")}${link.search}`;
    offers.set(id, {
      id,
      title: title.trim(),
      price: Math.round(price * 100) / 100,
      seller: seller || "Продавец не указан",
      sellerId: `${p.id}:${sellerId || seller || "unknown"}`,
      reviews: Number(reviews) || 0,
      online: !!online,
      attributes: {
        type1: "продажа",
        ...(p.id === "playerauctions"
          ? playerauctionsAccountAttributes(
              title,
              "",
              instant || undefined,
              properties,
            )
          : externalAttributes(title, properties)),
        ...(instant ? { auto: "1" } : {}),
        ...(typeof online === "boolean" ? { online_known: "1" } : {}),
        currency: p.currency,
        platform: p.id,
      },
      url: link.href,
    });
  }
  function structured(node) {
    if (!node || typeof node !== "object") return;
    if (node["@type"] === "Product") {
      for (const o of [node.offers].flat().filter(Boolean)) {
        if (o["@type"] !== "Offer" || o.availability?.endsWith("OutOfStock"))
          continue;
        add({
          url: node.url || o.url,
          title: node.name,
          price: amount(o.price),
          currency: o.priceCurrency,
          seller: o.seller?.name,
          sellerId: o.seller?.["@id"],
          properties: node.additionalProperty,
        });
      }
    }
    for (const v of Object.values(node))
      if (v && typeof v === "object") {
        if (Array.isArray(v)) v.forEach(structured);
        else structured(v);
      }
  }
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      structured(JSON.parse($(el).text()));
    } catch {
      /* unrelated malformed metadata */
    }
  });
  const g2gProperties = p.id === "g2g" ? g2gRankProperties(html) : new Map();
  if (p.id === "g2g")
    $('[aria-label="Product Card"]').each((i, el) => {
      const card = $(el),
        link = card.find('a[href*="/offer/"]').first();
      const sellerLink = card
        .find("a")
        .filter((i, a) => !$(a).attr("href")?.includes("/offer/"))
        .first();
      const text = card.text();
      const match = text.match(/Price\s*([\d,.]+)\s*(USD|EUR|GBP|RUB)/);
      add({
        url: link.attr("href"),
        title: link.attr("aria-label")?.replace(/^View /, ""),
        properties:
          g2gProperties.get(link.attr("href")?.split("/").at(-1)) ?? [],
        price: amount(match?.[1]),
        currency: match?.[2],
        seller: sellerLink.find(".truncate").first().text().trim(),
        sellerId: sellerLink.attr("href"),
        online: card.find(".h-user-avatar--online").length > 0,
        instant: /Delivery speed:\s*Instant/i.test(text),
      });
    });
  if (p.id === "z2u")
    $(".productCardStyle-2").each((i, el) => {
      const card = $(el),
        link = card.find("a.productName");
      const price = card.find(".priceTxt").text();
      add({
        url: link.attr("href"),
        title: link.text().trim(),
        price: amount(price),
        currency: /^\s*\$/.test(price) ? "USD" : "",
        seller: card.find(".userInfo .name").text().trim(),
        online: card.find(".userPhoto.on-line").length > 0,
        instant: /instant/i.test(card.find(".deliveryTimeLabel").text()),
      });
    });
  if (p.id === "plati")
    $("a[product_id]").each((i, el) => {
      const card = $(el),
        price = card.find(".title-bold").text();
      add({
        url: card.attr("href"),
        title: card.attr("title"),
        price: amount(price),
        currency: /₽|руб|RUB/i.test(price) ? "RUB" : "",
        seller: card.find(".caption-semibold").first().text().trim(),
      });
    });
  if (p.id === "playerok")
    $("[data-id]").each((i, el) => {
      const card = $(el);
      const link = card
        .find('a[href*="/products/"]')
        .filter((i, a) => $(a).text().trim())
        .first();
      const price = card.find("div.font-bold").first().text();
      if (!link.length || !/₽/.test(price)) return;
      const seller = card.find('a[href*="/profile/"]').first();
      const reviews = card
        .find("span")
        .filter((i, e) => /^[\d\s\u00a0]+$/.test($(e).text().trim()))
        .last()
        .text()
        .replace(/\D/g, "");
      add({
        url: link.attr("href"),
        title: link.text().trim(),
        price: amount(price),
        currency: "RUB",
        seller: seller.text().trim(),
        sellerId: seller.attr("href"),
        reviews: Number(reviews) || 0,
      });
    });
  if (p.id === "playerauctions")
    $('a[href*="/dota-2-account/"]').each((i, el) => {
      const link = $(el),
        href = link.attr("href");
      if (!/\/dota-2-account\/\d+a[!%]/i.test(href ?? "")) return;
      const title = link.attr("title") || link.text().trim();
      if (!title || /^(buy now|view|buy)$/i.test(title)) return;
      let card = link.parent();
      for (let depth = 0; depth < 7; depth++, card = card.parent()) {
        const urls = new Set(
          card
            .find('a[href*="/dota-2-account/"]')
            .map((i, a) => $(a).attr("href"))
            .get()
            .filter((h) => /\/\d+a[!%]/i.test(h)),
        );
        if (urls.size > 1 || !card.length || card.is("body,html")) break;
        const priceText = card
          .find('[itemprop="price"], .offer-price, .price')
          .first();
        const price =
          priceText.attr("content") ||
          priceText.text() ||
          card.text().match(/\$\s*([\d,.]+)/)?.[1];
        if (!price || !/\$|USD/i.test(card.text())) continue;
        const seller = card.find('a[href*="/store/"]').first();
        add({
          url: href,
          title,
          price: amount(price),
          currency: "USD",
          seller: seller.text().trim(),
          sellerId: seller.attr("href"),
          reviews:
            Number(
              card
                .find(".offer-rating")
                .first()
                .closest("li")
                .text()
                .match(/\(([\d,]+)\)/)?.[1]
                ?.replaceAll(",", ""),
            ) || 0,
          instant: card.find(".OLP-delivery-text").length
            ? /^\s*Instant\s*$/i.test(card.find(".OLP-delivery-text").text())
            : /instant/i.test(card.text()),
        });
        break;
      }
    });
  if (p.id === "eldorado")
    $('a[href*="/oa/"]').each((i, el) => {
      const card = $(el),
        price = card.find('[aria-label="amount-price"]').text();
      if (!/^\s*(?:\$|USD)/.test(price)) return;
      const title = [
        card.find(".offer-label").text().trim(),
        card.find(".offer-title").text().trim(),
      ]
        .filter(Boolean)
        .join(" · ");
      add({
        url: card.attr("href"),
        title,
        price: amount(price),
        currency: "USD",
        seller: card.find(".username").text().trim(),
        reviews:
          Number(
            card
              .find(".seller-details")
              .text()
              .match(/\(([\d,]+)\)/)?.[1]
              ?.replaceAll(",", ""),
          ) || 0,
        instant: /instant/i.test(
          card.find('[aria-label="Delivery time"]').text(),
        ),
      });
    });
  if (!offers.size)
    throw new Error(
      `${p.name}: объявления в ${p.currency} не найдены. Каталог загружается отдельно, изменена разметка или доступ ограничен. Снимок не сохранён.`,
    );
  return { offers: [...offers.values()], advertised: null, skipped };
}
async function fetchExternalHtml(category) {
  const p = platforms.find((p) => p.id === category.platform);
  if (!p || category.url !== p.url)
    throw new Error("Неизвестный адрес каталога");
  const response = await fetchListing(p.url, {
    redirect: "error",
    headers: {
      "User-Agent": "MarketLens/0.2 (public listing statistics)",
      "Accept-Language":
        p.region === "ru" ? "ru-RU,ru;q=0.9" : "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw upstreamError(p.name, response.status);
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 20 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Страница превышает лимит 20 МБ");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let collectionQueue = Promise.resolve();
export function withLargeCollection(read) {
  const result = collectionQueue.then(read);
  collectionQueue = result.catch(() => {});
  return result;
}
async function renderSnapshot(id) {
  try {
    return await renderCategory(id);
  } finally {
    await closeCollectionBrowser();
  }
}
async function fetchEldoradoPage() {
  const response = await fetchListing(
    "https://www.eldorado.gg/api/flexibleOffers?gameId=43&category=Account&pageSize=24&pageIndex=1",
    { headers: { Accept: "application/json" }, redirect: "error" },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw upstreamError("Eldorado.gg", response.status);
  }
  return response.json();
}

export function parseEldoradoPage({ results, recordCount, pageIndex }) {
  if (
    pageIndex !== 1 ||
    !Array.isArray(results) ||
    !results.length ||
    !Number.isSafeInteger(recordCount) ||
    recordCount < results.length
  )
    throw new Error("Eldorado.gg: неожиданный формат публичного каталога.");
  const offers = results.map(({ offer, user, userOrderInfo }) => {
    const price =
      offer?.pricePerUnitWithDiscount?.currency === "USD"
        ? offer.pricePerUnitWithDiscount
        : offer?.pricePerUnitInUSD;
    if (
      offer?.gameId !== "43" ||
      offer.category !== "Account" ||
      typeof offer.offerTitle !== "string" ||
      !offer.offerTitle.trim() ||
      typeof offer.id !== "string" ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(offer.id) ||
      price?.currency !== "USD" ||
      !Number.isFinite(price.amount) ||
      price.amount < 0
    )
      throw new Error("Eldorado.gg: некорректные данные карточки.");
    const rank = offer.attributes?.find((a) => a.id === "dota-2-rank")?.value
      ?.name;
    const title =
      typeof rank === "string" && rank
        ? `${rank} · ${offer.offerTitle}`
        : offer.offerTitle;
    const seller = user?.username || "Продавец не указан";
    const path = `/dota-accounts/oa/${offer.id}`;
    return {
      id: `eldorado:${path}`,
      title,
      price: Math.round(price.amount * 100) / 100,
      seller,
      sellerId: `eldorado:${user?.username || "unknown"}`,
      reviews: Number(userOrderInfo?.ratingCount) || 0,
      online: false,
      attributes: {
        type1: "продажа",
        ...externalAttributes(title),
        ...(offer.guaranteedDeliveryTime === "Instant" ? { auto: "1" } : {}),
        platform: "eldorado",
        currency: "USD",
      },
      url: `https://www.eldorado.gg${path}`,
    };
  });
  return { offers, advertised: recordCount, skipped: 0 };
}
export async function fetchExternalCategory(
  category,
  {
    loadHtml = fetchExternalHtml,
    render = renderSnapshot,
    playerok = fetchPlayerokCategory,
    onProgress,
    playerauctions = fetchPlayerauctionsBrowser,
    eldorado = fetchEldoradoPage,
  } = {},
) {
  const p = platforms.find((p) => p.id === category.platform);
  if (!p || category.url !== p.url)
    throw new Error("Неизвестный адрес каталога");
  if (p.id === "playerok") return playerok({ onProgress });
  if (p.id === "playerauctions")
    return withLargeCollection(() =>
      retrySnapshot(() =>
        playerauctions({
          onProgress,
          parsePage: (html) => parseExternalOffers(html, "playerauctions"),
        }),
      ),
    );
  const fromBrowser = () =>
    withLargeCollection(() =>
      retrySnapshot(async () => parseExternalOffers(await render(p.id), p.id)),
    );
  try {
    if (p.id === "eldorado")
      return parseEldoradoPage(await retrySnapshot(eldorado));
    return parseExternalOffers(
      await retrySnapshot(() => loadHtml(category)),
      p.id,
    );
  } catch (error) {
    try {
      return fromBrowser();
    } catch (browserError) {
      throw new Error(
        `${p.name}: автосбор не получил данные. ${browserError.message} Первый запрос: ${error.message}`,
      );
    }
  }
}
