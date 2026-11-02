import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPlayerokCategory,
  playerokAttributes,
} from "../server/playerok-collector.mjs";
import { createDatabase, saveSnapshot } from "../server/db.mjs";
import { analyze, querySchema, exportRows } from "../server/analytics.mjs";
const game = { id: "1ed59fc7-5a1e-6bd0-d573-07c8a022ecaa" },
  category = { id: "1ed5a056-002d-6c90-56ff-eaf27c161cdb" };
const item = (id, attrs = {}) => ({
  id,
  slug: "ad-" + id,
  name: "Account 7000 MMR",
  price: 10,
  status: "APPROVED",
  attributes: attrs,
  game,
  category,
  seller: { id: "seller", username: "Seller", testimonialCounter: 33 },
});
const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
const q = (extra) =>
  querySchema.parse({ from: today, to: today, market: "playerok", ...extra });
test("Playerok follows pagination and uses current structured attributes for filters, CSV, prices and original links", async () => {
  const lots = [
    item("one", {
      "rating available": true,
      mmr: 5400,
      "conduct-summary": 11000,
      polite: 12000,
    }),
    item("two", { "rating available": false, mmr: 6000 }),
    item("three", { mmr: 7000 }),
    item("four", {
      "rating available": true,
      mmr: 0,
      "calibration-completed": false,
    }),
  ];
  let pages = 0,
    details = 0;
  const r = await fetchPlayerokCategory({
    requestData: async (url, body) => {
      if (url.includes("/graphql")) {
        details++;
        assert.equal(body.operationName, "item");
        let d = lots.find((d) => d.id === body.variables.id);
        return { data: { item: { ...d, price: 25 } } };
      }
      pages++;
      if (pages === 1) {
        assert.equal(body.page.cursor, undefined);
        return {
          items: lots.slice(0, 2),
          hasNextPage: true,
          endCursor: "next",
        };
      }
      assert.equal(body.page.cursor, "next");
      return { items: lots.slice(2), hasNextPage: false };
    },
  });
  assert.equal(pages, 2);
  assert.equal(details, 4);
  assert.equal(r.offers.length, 4);
  assert.equal(r.offers.find((o) => o.url.endsWith("ad-one")).price, 25);
  assert.equal(r.offers[0].seller, "Seller");
  assert.equal(r.offers[0].reviews, 33);
  const db = createDatabase();
  try {
    saveSnapshot(db, "playerok-accounts", r.offers);
    assert.equal(
      analyze(db, q({ saleType: "sale", accountType: "ranked" })).stats.count,
      2,
    );
    const filters = q({
      saleType: "sale",
      accountType: "ranked",
      mmrMin: 5400,
      mmrMax: 5400,
      decencyMin: 11000,
      politenessMin: 12000,
    });
    const result = analyze(db, filters);
    assert.equal(result.stats.count, 1);
    assert.equal(result.stats.median, 25);
    assert.equal(exportRows(db, filters).length, 1);
    assert.equal(
      analyze(db, q({ accountType: "ranked", mmrMax: 0 })).stats.count,
      1,
    );
  } finally {
    db.close();
  }
});
test("Playerok explicit false is closed, missing access is unknown, rental and zero stay distinct", () => {
  assert.equal(
    playerokAttributes("открыт рейтинг", { "rating available": false })
      .ranked_access,
    "closed",
  );
  assert.equal(
    playerokAttributes("7000 MMR", { mmr: 7000 }).ranked_access,
    "unknown",
  );
  assert.equal(
    playerokAttributes("Аренда", { "rating available": true, mmr: 0 }).type1,
    "аренда",
  );
  assert.equal(playerokAttributes("Account", { mmr: 0 }).solommr, "0");
  assert.equal(
    playerokAttributes("Account", { mmr: 6000, "rating available": true })
      .ranked_access_source,
    "Playerok: Доступен рейтинг",
  );
});
test("Playerok rejects repeating pagination and missing account details rather than saving an incomplete snapshot", async () => {
  await assert.rejects(
    () =>
      fetchPlayerokCategory({
        requestData: async () => ({
          items: [item("one")],
          hasNextPage: true,
          endCursor: "same",
        }),
      }),
    /следующую страницу/,
  );
  await assert.rejects(
    () =>
      fetchPlayerokCategory({
        requestData: async (url) =>
          url.includes("/graphql")
            ? { data: {} }
            : { items: [item("one")], hasNextPage: false },
      }),
    /неполные данные/,
  );
});

test("PlayerAuctions original offer URLs, USD, explicit ranked access and ranges filter consistently", async () => {
  const { parseExternalOffers } = await import(
    "../server/external-collector.mjs"
  );
  const rows = [
    ["one", "Ranked Ready 6000 MMR", true],
    ["two", "Ranked Locked 6500 MMR", false],
    ["three", "Immortal 7000 MMR", null],
  ];
  const html =
    '<script type="application/ld+json">' +
    JSON.stringify(
      rows.map(([id, name, open], i) => ({
        "@type": "Product",
        name,
        url: `https://www.playerauctions.com/dota-2-account/${100 + i}a!${id}/`,
        additionalProperty:
          open === null ? [] : [{ name: "Ranked access", value: open }],
        offers: { "@type": "Offer", price: 30 + i, priceCurrency: "USD" },
      })),
    ) +
    "</script>";
  const parsed = parseExternalOffers(html, "playerauctions");
  assert.equal(parsed.offers.length, 3);
  const db = createDatabase();
  try {
    saveSnapshot(db, "playerauctions-accounts", parsed.offers);
    const filters = q({
      market: "playerauctions",
      saleType: "sale",
      accountType: "ranked",
      mmrMin: 5400,
    });
    const a = analyze(db, filters);
    assert.equal(a.stats.count, 1);
    assert.equal(a.currency, "USD");
    assert.equal(exportRows(db, filters).length, 1);
  } finally {
    db.close();
  }
});

test("PlayerAuctions category cards keep individual price and seller without mixing adjacent ads", async () => {
  const { parseExternalOffers } = await import(
    "../server/external-collector.mjs"
  );
  const html = `<div class="list"><article><a href="/dota-2-account/123a!ranked-ready/">Ranked Ready 6000 MMR</a><a href="/store/seller-one/">Seller One</a><span class="offer-price">$ 31.00</span><span>Instant</span><a href="/dota-2-account/123a!ranked-ready/">BUY NOW</a></article><article><a href="/dota-2-account/456a!rank-locked/">Rank Locked 3000 MMR</a><a href="/store/seller-two/">Seller Two</a><span class="offer-price">$ 9.00</span></article></div>`;
  const { offers } = parseExternalOffers(html, "playerauctions");
  assert.equal(offers.length, 2);
  assert.equal(offers[0].price, 31);
  assert.equal(offers[1].price, 9);
  assert.equal(offers[0].seller, "Seller One");
  assert.equal(offers[0].attributes.ranked_access, "open");
  assert.equal(offers[1].attributes.ranked_access, "closed");
  assert.equal(offers[0].attributes.auto, "1");
});
