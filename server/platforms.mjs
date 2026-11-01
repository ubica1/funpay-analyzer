export const platforms = [
  {
    id: "funpay",
    name: "FunPay",
    region: "ru",
    currency: "RUB",
    url: "https://funpay.com/lots/81/",
  },
  {
    id: "ggsel",
    name: "GGSel",
    region: "ru",
    currency: "RUB",
    url: "https://ggsel.net/catalog/dota2-accounts",
  },
  {
    id: "playerok",
    browser: true,
    name: "Playerok",
    region: "ru",
    currency: "RUB",
    url: "https://playerok.com/dota-2/accounts",
  },
  {
    id: "plati",
    name: "Plati",
    region: "ru",
    currency: "RUB",
    url: "https://plati.market/games/dota-2/1243/",
  },
  {
    id: "eldorado",
    browser: true,
    name: "Eldorado.gg",
    region: "foreign",
    currency: "USD",
    url: "https://www.eldorado.gg/dota-accounts/a/43-0-0",
  },
  {
    id: "g2g",
    name: "G2G",
    region: "foreign",
    currency: "USD",
    url: "https://www.g2g.com/categories/dota-2-accounts-for-sale",
  },
  {
    id: "z2u",
    name: "Z2U",
    region: "foreign",
    currency: "USD",
    url: "https://www.z2u.com/dota-2/accounts-5-8413",
  },
];
export const marketIds = ["ru", "foreign", ...platforms.map((p) => p.id)];
export function marketPlatforms(market = "funpay") {
  return platforms.filter((p) => p.id === market || p.region === market);
}
export function marketCurrency(market) {
  return marketPlatforms(market)[0]?.currency ?? "RUB";
}
export function selectedCategoryIds(db, q, enabled = false) {
  const allowed = new Set(marketPlatforms(q.market).map((p) => p.id));
  const requested = q.category.split(",");
  return db
    .prepare("SELECT * FROM categories")
    .all()
    .filter(
      (c) =>
        allowed.has(c.platform) &&
        (!enabled || c.enabled) &&
        (q.category === "all" ||
          requested.includes(c.id) ||
          requested.includes(c.kind)),
    )
    .map((c) => c.id);
}
