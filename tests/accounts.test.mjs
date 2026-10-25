import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, saveSnapshot } from "../server/db.mjs";
import { analyze, exportRows, csv, querySchema } from "../server/analytics.mjs";
import { parseOffers } from "../server/collector.mjs";
import { attributeNumber } from "../server/account-fields.mjs";

const q = (values) =>
  querySchema.parse({ from: "2026-10-01", to: "2026-10-07", ...values });
const offer = (id, fields = {}, price = 100) => ({
  id,
  title: `Аккаунт ${id}`,
  price,
  seller: `seller-${id}`,
  sellerId: id,
  reviews: 100,
  online: true,
  attributes: fields,
  url: `https://funpay.com/lots/offer?id=${id}`,
});
const save = (db, rows, at = "2026-10-07T12:00:00.000Z") =>
  saveSnapshot(db, "accounts", rows, {}, at);

test("MMR sorting is numeric, deterministic, nulls last in both directions and CSV matches table", () => {
  const db = createDatabase();
  try {
    save(db, [
      offer("1", { solommr: "10000" }, 80),
      offer("2", { solommr: "900" }, 100),
      offer("3", { solommr: "2500" }, 200),
      offer("4", {}, 1),
      offer("5", { solommr: "unknown" }, 2),
      offer("6", { solommr: "3 500" }, 50),
      offer("7", { solommr: "2500" }, 150),
    ]);
    const asc = q({ sort: "mmr_asc" }),
      desc = q({ sort: "mmr_desc" });
    assert.deepEqual(
      analyze(db, asc).offers.map((o) => o.offer_id),
      ["2", "7", "3", "6", "1", "4", "5"],
    );
    assert.deepEqual(
      analyze(db, desc).offers.map((o) => o.offer_id),
      ["1", "6", "7", "3", "2", "4", "5"],
    );
    assert.deepEqual(
      exportRows(db, asc).map((o) => o.offer_id),
      analyze(db, asc).offers.map((o) => o.offer_id),
    );
    assert.equal(exportRows(db, asc)[0].mmr, 900);
    assert.ok(
      csv(exportRows(db, asc))
        .split("\r\n")[0]
        .includes("mmr;sale_type;account_type"),
    );
  } finally {
    db.close();
  }
});

test("sale, rank, MMR and automatic delivery filter every view and previous period consistently", () => {
  const db = createDatabase();
  try {
    const base = {
      type1: "продажа",
      type: "с рейтингом",
      solommr: "4000",
      auto: "1",
    };
    save(db, [
      offer("1", base, 100),
      offer("2", { ...base, type1: "аренда" }, 200),
      offer("3", { ...base, solommr: "5001" }, 300),
      offer("4", { ...base, auto: "0" }, 400),
      offer("5", { ...base, type: "под калибровку (tbd)" }, 500),
    ]);
    save(
      db,
      [offer("1", base, 50), offer("2", { ...base, type1: "аренда" }, 1)],
      "2026-09-30T12:00:00.000Z",
    );
    const params = q({
      saleType: "sale",
      accountType: "ranked",
      mmrMin: 4000,
      mmrMax: 5000,
      auto: "1",
    });
    const d = analyze(db, params);
    assert.equal(d.stats.count, 1);
    assert.equal(d.stats.median, 100);
    assert.equal(d.previous.median, 50);
    assert.equal(d.series[0].count, 1);
    assert.equal(d.sellers.length, 1);
    assert.equal(d.comparison[0].count, 1);
    assert.equal(
      d.histogram.reduce((n, b) => n + b.count, 0),
      1,
    );
    assert.deepEqual(
      d.offers.map((o) => o.offer_id),
      ["1"],
    );
    assert.deepEqual(
      exportRows(db, params).map((o) => o.offer_id),
      ["1"],
    );
    assert.equal(analyze(db, q({ saleType: "rent" })).stats.count, 1);
    assert.equal(analyze(db, q({ accountType: "calibration" })).stats.count, 1);
  } finally {
    db.close();
  }
});

test("all account numeric ranges combine inclusively; zero is valid and missing values stay unknown", () => {
  const db = createDatabase();
  try {
    const fields = {
      solommr: "0",
      decency: "10000",
      politeness: "11000",
      games: "500",
      time: "1000",
    };
    save(db, [
      offer("1", fields),
      offer("2", { ...fields, decency: "9000" }),
      offer("3", { ...fields, solommr: "not specified" }),
      offer("4", { ...fields, solommr: "" }),
      offer("5", { mmr: "4000" }),
    ]);
    const params = q({
      mmrMin: 0,
      mmrMax: 0,
      decencyMin: 10000,
      decencyMax: 10000,
      politenessMin: 11000,
      politenessMax: 11000,
      gamesMin: 500,
      gamesMax: 500,
      hoursMin: 1000,
      hoursMax: 1000,
    });
    assert.deepEqual(
      analyze(db, params).offers.map((o) => o.offer_id),
      ["1"],
    );
    assert.equal(analyze(db, q()).stats.count, 5);
    assert.equal(analyze(db, q({ auto: "1" })).stats.count, 0);
  } finally {
    db.close();
  }
});

test("account field parsing accepts structured numbers and rejects text, bounds, objects and title inference", () => {
  for (const [raw, expected] of [
    ["4 000", 4000],
    ["4\u00a0000", 4000],
    ["2500,5", 2500.5],
    ["0", 0],
    ["", null],
    ["4000-5000", null],
    ["MMR 4000", null],
    ["-1", null],
    ["1e4", null],
    ["Infinity", null],
    [{}, null],
    ["1000000001", null],
  ])
    assert.equal(attributeNumber({ solommr: raw }, "solommr"), expected);
  assert.equal(attributeNumber("{bad JSON", "solommr"), null);
  const db = createDatabase();
  try {
    save(db, [{ ...offer("1", {}), title: "Аккаунт 10000 MMR" }]);
    assert.equal(analyze(db, q({ mmrMin: 1 })).stats.count, 0);
  } finally {
    db.close();
  }
});

test("Russian sale/rank values are case insensitive; unranked and rental remain distinct", () => {
  const db = createDatabase();
  try {
    save(db, [
      offer("1", { type1: "Продажа", type: "Без доступа к рейтинговым играм" }),
      offer("2", { type1: "АРЕНДА" }),
      offer("3", { type1: "неизвестно" }),
    ]);
    assert.equal(
      analyze(db, q({ saleType: "sale", accountType: "unranked" })).stats.count,
      1,
    );
    assert.equal(analyze(db, q({ saleType: "rent" })).stats.count, 1);
    assert.equal(analyze(db, q()).stats.count, 3);
  } finally {
    db.close();
  }
});

test("numeric sorting supports behaviour, communication score, games and hours", () => {
  const db = createDatabase();
  try {
    save(db, [
      offer("1", {
        decency: "900",
        politeness: "10000",
        games: "20",
        time: "50",
      }),
      offer("2", {
        decency: "10000",
        politeness: "900",
        games: "100",
        time: "1000",
      }),
      offer("3", {}, 1),
    ]);
    for (const sort of ["decency_desc", "games_desc", "hours_desc"])
      assert.equal(analyze(db, q({ sort })).offers[0].offer_id, "2");
    assert.equal(
      analyze(db, q({ sort: "politeness_desc" })).offers[0].offer_id,
      "1",
    );
  } finally {
    db.close();
  }
});

test("facet values stay available without active account filters and are capped per key", () => {
  const db = createDatabase();
  try {
    save(
      db,
      Array.from({ length: 350 }, (_, i) =>
        offer(
          String(i),
          {
            decency: String(i),
            solommr: String(i),
            type1: i % 2 ? "аренда" : "продажа",
            type: "с рейтингом",
          },
          i + 1,
        ),
      ),
    );
    const d = analyze(db, q({ saleType: "sale", mmrMin: 349 }));
    assert.equal(d.stats.count, 0);
    assert.equal(d.facets.filter((f) => f.key === "decency").length, 60);
    assert.deepEqual(
      d.facets
        .filter((f) => f.key === "type1")
        .map((f) => f.value)
        .sort(),
      ["аренда", "продажа"],
    );
  } finally {
    db.close();
  }
});

test("invalid account filters and reversed intervals are rejected before querying", () => {
  for (const bad of [
    { saleType: "sell" },
    { accountType: "random" },
    { auto: "true" },
    { mmrMin: -1 },
    { mmrMin: "NaN" },
    { mmrMin: 5000, mmrMax: 4000 },
    { decencyMin: 12000, decencyMax: 10000 },
    { politenessMin: 100, politenessMax: 1 },
    { gamesMin: 2, gamesMax: 1 },
    { hoursMin: 2, hoursMax: 1 },
  ])
    assert.throws(() => q(bad));
  assert.equal(q({ mmrMin: "", mmrMax: "" }).mmrMin, undefined);
});

test("parser preserves every FunPay account attribute and explicit auto-delivery flag", () => {
  const html = `<title>Dota 2</title><a class="tc-item" href="https://funpay.com/lots/offer?id=123" data-auto="1" data-f-type1="продажа" data-f-type="с рейтингом" data-f-solommr="4500" data-f-decency="12000" data-f-politeness="11000" data-f-games="500" data-f-time="2000"><div class="tc-desc-text">Аккаунт</div><div class="media-user-name">Seller</div><div class="tc-price" data-s="200"><span class="unit">₽</span></div></a>`;
  assert.deepEqual(
    parseOffers(html, "https://funpay.com/lots/81/").offers[0].attributes,
    {
      auto: "1",
      type1: "продажа",
      type: "с рейтингом",
      solommr: "4500",
      decency: "12000",
      politeness: "11000",
      games: "500",
      time: "2000",
    },
  );
});
