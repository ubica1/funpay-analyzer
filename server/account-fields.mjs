// FunPay Dota 2 account fields; numeric values come only from structured attributes.
export const accountRanges = [
  ["mmr", "solommr"],
  ["decency", "decency"],
  ["politeness", "politeness"],
  ["games", "games"],
  ["hours", "time"],
];
export const saleTypes = { sale: "продажа", rent: "аренда" };
export const accountTypes = {
  ranked: "с рейтингом",
  calibration: "под калибровку (tbd)",
  unranked: "без доступа к рейтинговым играм",
};
function attribute(json, key) {
  try {
    return typeof json === "string" ? JSON.parse(json)[key] : json?.[key];
  } catch {
    return undefined;
  }
}
export function attributeNumber(json, key) {
  const raw = attribute(json, key);
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value <= 1e9 ? value : null;
}
export function attributeText(json, key) {
  const value = attribute(json, key);
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase("ru-RU")
    : null;
}
export const accountFilterDefaults = {
  saleType: "all",
  accountType: "all",
  auto: "all",
  mmrMin: undefined,
  mmrMax: undefined,
  decencyMin: undefined,
  decencyMax: undefined,
  politenessMin: undefined,
  politenessMax: undefined,
  gamesMin: undefined,
  gamesMax: undefined,
  hoursMin: undefined,
  hoursMax: undefined,
};
export function offerSort(sort) {
  const numeric = {
    mmr_asc: ["solommr", "ASC"],
    mmr_desc: ["solommr", "DESC"],
    decency_desc: ["decency", "DESC"],
    politeness_desc: ["politeness", "DESC"],
    games_desc: ["games", "DESC"],
    hours_desc: ["time", "DESC"],
  }[sort];
  if (numeric) {
    const expression = `attribute_number(attributes, '${numeric[0]}')`;
    return `${expression} IS NULL ASC, ${expression} ${numeric[1]}, price ASC, offer_id ASC`;
  }
  return (
    {
      price_asc: "price ASC,offer_id",
      price_desc: "price DESC,offer_id",
      reviews_desc: "reviews DESC,price,offer_id",
      title: "title,offer_id",
    }[sort] ?? "price ASC,offer_id"
  );
}
