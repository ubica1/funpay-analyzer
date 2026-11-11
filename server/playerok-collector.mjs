import { setTimeout as delay } from "node:timers/promises";
import { fetchListing, retrySnapshot, upstreamError } from "./http.mjs";
import { externalAttributes } from "./external-fields.mjs";

const gameId = "1ed59fc7-5a1e-6bd0-d573-07c8a022ecaa";
const categoryId = "1ed5a056-002d-6c90-56ff-eaf27c161cdb";
let nextRequestAt = 0;
async function request(url, body) {
  return retrySnapshot(() => readPage(url, body));
}
async function readPage(url, body) {
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
    if (!response.ok) {
      await response.body?.cancel();
      throw upstreamError("Playerok", response.status);
    }
    const data = await response.json();
    if (data.errors?.length)
      throw new Error(
        "Playerok: не удалось получить параметры объявлений. Новый снимок не сохранён.",
      );
    return data;
  }
}
export function playerokAttributes(title, values = {}, instant) {
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
  if (typeof instant === "boolean") result.auto = instant ? "1" : "0";
  return result;
}
const query = `query items($filter:ItemFilter,$pagination:Pagination){
  items(filter:$filter,pagination:$pagination){
    edges{node{id slug name price attributes status isAutomated
      user{id username testimonialCounter} game{id slug} category{id slug}}}
    pageInfo{hasNextPage endCursor} totalCount
  }
}`;
export async function fetchPlayerokCategory({
  requestData = request,
  onProgress = () => {},
} = {}) {
  const offers = new Map();
  const cursors = new Set();
  let cursor,
    advertised = null,
    skipped = 0;
  for (let page = 0; ; page++) {
    if (page >= 100)
      throw new Error(
        "Playerok: превышен лимит страниц. Неполный снимок не сохранён.",
      );
    // This is the public listing query used by Playerok. Account attributes are
    // available on ItemProfile itself: no per-listing browser or detail fetches.
    const response = await requestData("https://playerok.com/graphql", {
      operationName: "items",
      query,
      variables: {
        filter: { gameId, gameCategoryId: categoryId },
        pagination: { first: 24, ...(cursor ? { after: cursor } : {}) },
      },
    });
    const data = response.data?.items;
    if (
      !Array.isArray(data?.edges) ||
      typeof data.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error(
        "Playerok: изменился формат каталога. Снимок не сохранён.",
      );
    if (Number.isInteger(data.totalCount)) advertised = data.totalCount;
    for (const { node: d } of data.edges) {
      if (d === null || (d?.status && d.status !== "APPROVED")) {
        skipped++;
        continue;
      }
      if (d?.game?.id !== gameId || d?.category?.id !== categoryId) {
        skipped++;
        continue;
      }
      if (
        !d.id ||
        (d.attributes != null && typeof d.attributes !== "object") ||
        typeof d.slug !== "string" ||
        !/^[^/?#\s]+$/u.test(d.slug) ||
        !d.name ||
        !Number.isFinite(d.price) ||
        d.price < 0
      )
        throw new Error(
          `Playerok: неполные данные объявления (${d.id ?? "без ID"}). Снимок не сохранён.`,
        );
      const url = `https://playerok.com/products/${encodeURIComponent(d.slug)}`;
      const id = `playerok:/products/${d.slug}`;
      offers.set(id, {
        id,
        title: d.name,
        price: d.price,
        seller: d.user?.username || "Продавец не указан",
        sellerId: `playerok:${d.user?.id || "unknown"}`,
        reviews: d.user?.testimonialCounter || 0,
        online: false,
        attributes: playerokAttributes(
          d.name,
          d.attributes ?? {},
          d.isAutomated,
        ),
        url,
      });
    }
    onProgress({ completed: offers.size, total: advertised ?? offers.size });
    if (!data.pageInfo.hasNextPage) break;
    const next = data.pageInfo.endCursor;
    if (!next || cursors.has(next) || !data.edges.length)
      throw new Error(
        "Playerok: не удалось получить следующую страницу. Снимок не сохранён.",
      );
    cursor = next;
    cursors.add(cursor);
  }
  if (!offers.size)
    throw new Error(
      "Playerok: активные объявления не найдены. Снимок не сохранён.",
    );
  return { offers: [...offers.values()], advertised, skipped };
}
