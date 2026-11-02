import { setTimeout as delay } from "node:timers/promises";
import { fetchListing } from "./http.mjs";
import { externalAttributes } from "./external-fields.mjs";

const gameId = "1ed59fc7-5a1e-6bd0-d573-07c8a022ecaa";
const categoryId = "1ed5a056-002d-6c90-56ff-eaf27c161cdb";
let nextRequestAt = 0;
async function request(url, body) {
  // Share a modest rate across catalog and detail requests. Playerok rejects bursts.
  const at = Math.max(Date.now(), nextRequestAt);
  nextRequestAt = at + 150;
  if (at > Date.now()) await delay(at - Date.now());
  for (let attempt = 0; ; attempt++) {
    const response = await fetchListing(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://playerok.com",
        Referer: "https://playerok.com/dota-2/accounts",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 2) {
      const header = response.headers.get("retry-after");
      const wait =
        header == null
          ? 10000
          : /^\d+$/.test(header)
            ? Number(header) * 1000
            : Math.max(0, Date.parse(header) - Date.now());
      if (Number.isFinite(wait) && wait <= 30000) {
        await response.body?.cancel();
        nextRequestAt = Math.max(nextRequestAt, Date.now() + wait);
        await delay(Math.max(1000, wait));
        continue;
      }
    }
    if (!response.ok)
      throw new Error(
        `Playerok: HTTP ${response.status}. Новый снимок не сохранён.`,
      );
    const data = await response.json();
    if (data.errors?.length)
      throw new Error(
        "Playerok: не удалось получить параметры объявлений. Новый снимок не сохранён.",
      );
    return data;
  }
}
export function playerokAttributes(title, values = {}, instant = false) {
  const fields = {
    mmr: "MMR",
    "conduct-summary": "behavior",
    polite: "communication",
  };
  const props = Object.entries(fields).flatMap(([key, name]) =>
    typeof values[key] === "number" &&
    Number.isInteger(values[key]) &&
    values[key] >= 0
      ? [{ name, value: values[key] }]
      : [],
  );
  const ranked = values["rating available"];
  if (typeof ranked === "boolean")
    props.push({ name: "доступен рейтинг", value: ranked });
  const result = {
    type1: "продажа",
    ...externalAttributes(title, props),
    platform: "playerok",
    currency: "RUB",
  };
  if (typeof ranked === "boolean")
    result.ranked_access_source = "Playerok: Доступен рейтинг";
  if (
    values["calibration-completed"] === false &&
    result.ranked_access !== "closed"
  )
    result.type = "под калибровку (tbd)";
  if (props.some((p) => p.name !== "доступен рейтинг"))
    result.parameter_source = "Параметры объявления Playerok";
  if (instant) result.auto = "1";
  return result;
}
export async function fetchPlayerokCategory({ requestData = request } = {}) {
  const deadline = Date.now() + 360000;
  const items = new Map();
  let cursor;
  const cursors = new Set();
  // The catalog endpoint is the same public endpoint used by the marketplace.
  // Follow every cursor: collecting the first 48 cards silently loses matches.
  for (let page = 0; ; page++) {
    if (page >= 100)
      throw new Error(
        "Playerok: превышен лимит страниц. Неполный снимок не сохранён.",
      );
    const data = await requestData(
      "https://api.playerok.com/v1/catalog/items",
      {
        filter: { gameIds: [gameId], gameCategoryIds: [categoryId] },
        page: { size: 100, order: "PRICE_ASC", ...(cursor ? { cursor } : {}) },
      },
    );
    if (!Array.isArray(data.items) || typeof data.hasNextPage !== "boolean")
      throw new Error(
        "Playerok: изменился формат каталога. Снимок не сохранён.",
      );
    for (const item of data.items) {
      if (item.game?.id !== gameId || item.category?.id !== categoryId)
        continue;
      if (typeof item.id === "string") items.set(item.id, item);
    }
    if (!data.hasNextPage) break;
    if (!data.endCursor || cursors.has(data.endCursor) || !data.items.length)
      throw new Error(
        "Playerok: не удалось получить следующую страницу. Снимок не сохранён.",
      );
    cursor = data.endCursor;
    cursors.add(cursor);
  }
  if (!items.size)
    throw new Error(
      "Playerok: каталог не вернул объявления. Снимок не сохранён.",
    );
  const offers = [];
  const entries = [...items.values()];
  let nextBatch = 0;
  let failed = false;
  // Fetch only public account attributes. Never request credentials or deal data.
  async function worker() {
    while (!failed && nextBatch < entries.length) {
      if (Date.now() > deadline)
        throw new Error(
          "Playerok: сбор превысил 6 минут. Неполный снимок не сохранён.",
        );
      const item = entries[nextBatch++];
      const details = await requestData("https://playerok.com/graphql", {
        operationName: "item",
        query:
          "query item($id:UUID){item(id:$id){id slug name price attributes status isAutomated}}",
        variables: { id: item.id },
      });
      if (!details.data)
        throw new Error(
          "Playerok: параметры объявлений не получены. Снимок не сохранён.",
        );
      const d = details.data.item;
      // Removed listings are absent from the current snapshot, never replaced by old data.
      if (d === null || (d?.status && d.status !== "APPROVED")) continue;
      if (
        !d ||
        d.id !== item.id ||
        typeof d.attributes !== "object" ||
        d.attributes === null ||
        !/^[a-z0-9-]+$/i.test(d.slug) ||
        !d.name ||
        !Number.isFinite(d.price) ||
        d.price < 0
      )
        throw new Error(
          "Playerok: неполные данные объявления. Снимок не сохранён.",
        );
      const url = `https://playerok.com/products/${d.slug}`;
      offers.push({
        id: `playerok:/products/${d.slug}`,
        title: d.name,
        price: d.price,
        seller: item.seller?.username || "Продавец не указан",
        sellerId: `playerok:${item.seller?.id || "unknown"}`,
        reviews: item.seller?.testimonialCounter || 0,
        online: false,
        attributes: playerokAttributes(
          d.name,
          d.attributes,
          d.isAutomated === true,
        ),
        url,
      });
    }
  }
  // Await all workers even on failure so abandoned requests cannot overlap the next run.
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      worker().catch((error) => {
        failed = true;
        throw error;
      }),
    ),
  );
  const failure = results.find((r) => r.status === "rejected");
  if (failure) throw failure.reason;
  if (!offers.length)
    throw new Error(
      "Playerok: активные объявления не найдены. Снимок не сохранён.",
    );
  return {
    offers,
    advertised: entries.length,
    skipped: entries.length - offers.length,
  };
}
