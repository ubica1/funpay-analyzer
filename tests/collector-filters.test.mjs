import test from "node:test";
import assert from "node:assert/strict";
import {
  externalAttributes,
  backfillExternalFields,
} from "../server/external-fields.mjs";
import { parseExternalOffers } from "../server/external-collector.mjs";
import { createCollector } from "../server/collector.mjs";
import { createDatabase, saveSnapshot } from "../server/db.mjs";
import { analyze, querySchema, exportRows } from "../server/analytics.mjs";
const offer = (id, attributes = {}) => ({
  id,
  title: "Dota 2 account",
  price: 10,
  seller: "Seller",
  sellerId: id,
  reviews: 0,
  online: false,
  attributes,
  url: "https://www.g2g.com/offer/" + id,
});
const q = (extra) => {
  const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
  return querySchema.parse({ from: today, to: today, market: "g2g", ...extra });
};

test("external titles extract explicit bilingual account parameters but not ranges or minimums", () => {
  const fields = externalAttributes(
    "Calibrated 2529 MMR [Behavior 8763] [100-300 Hrs]",
  );
  assert.equal(fields.solommr, "2529");
  assert.equal(fields.decency, "8763");
  assert.equal(fields.time, undefined);
  assert.equal(
    externalAttributes(
      "MMR=4630 | порядочность 12000 | 453 matches | 700 hours",
    ).solommr,
    "4630",
  );
  assert.equal(externalAttributes("10k Behavior | MMR-1600").decency, "10000");
  assert.equal(externalAttributes("10k Behavior | MMR-1600").solommr, "1600");
  assert.equal(externalAttributes("Rent account | MMR 0").type1, "аренда");
  assert.equal(
    externalAttributes("TBD | 1500-2500 MMR").type,
    "под калибровку (tbd)",
  );
  for (const title of [
    "1500-2500 MMR",
    "MMR 1500–2500",
    "3000+ MMR",
    "MMR 3000+",
    "MMR 2,5",
    "3000 MMR and 5000 MMR",
  ])
    assert.equal(externalAttributes(title).solommr, undefined, title);
  assert.equal(externalAttributes("500-1000 hours").time, undefined);
  assert.equal(externalAttributes("100+ hours").time, undefined);
  assert.equal(
    externalAttributes("670 MMR", [{ name: "MMR", value: 0 }]).solommr,
    "0",
  );
});

test("external structured attributes and title fields filter stats, chart, sellers and CSV consistently", () => {
  const db = createDatabase();
  try {
    const products = [
      ["one", "2529 MMR Behavior 8763"],
      ["two", "MMR 5000 Behavior 12000"],
      ["three", "1500-2500 MMR"],
    ].map(([id, title]) => ({
      "@type": "Product",
      name: title,
      url: `https://www.g2g.com/offer/${id}`,
      offers: {
        "@type": "Offer",
        price: "20",
        priceCurrency: "USD",
        seller: { name: id },
      },
    }));
    const parsed = parseExternalOffers(
      `<script type="application/ld+json">${JSON.stringify(products)}</script>`,
      "g2g",
    );
    saveSnapshot(db, "g2g-accounts", parsed.offers);
    const filtered = analyze(db, q({ mmrMin: 3000, decencyMin: 10000 }));
    assert.equal(filtered.stats.count, 1);
    assert.equal(filtered.series[0].count, 1);
    assert.equal(filtered.sellers.length, 1);
    assert.equal(exportRows(db, q({ mmrMin: 3000 })).length, 1);
    assert.equal(filtered.availableFilters.mmr, 3);
    assert.equal(filtered.availableTotal, 3);
    assert.equal(filtered.availableFilters.politeness, 0);
    assert.equal(analyze(db, q({ mmrMin: 9000 })).availableFilters.mmr, 3);
  } finally {
    db.close();
  }
});

test("manual collection scopes to chosen market and enables browser marketplaces", async () => {
  const db = createDatabase(),
    calls = [];
  const collector = createCollector(db, {
    fetchExternal: async (c) => {
      calls.push(c.platform);
      return { offers: [offer(c.platform)] };
    },
    fetchPublic: async () => {
      throw new Error("Unexpected FunPay request");
    },
    pauseMs: 0,
  });
  try {
    await collector.collect({ market: "g2g", category: "accounts" });
    assert.deepEqual(calls, ["g2g"]);
    assert.equal(collector.status().total, 1);
    assert.equal(collector.status().completed, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, 1);
    db.prepare(
      "UPDATE categories SET enabled=1 WHERE platform='playerok'",
    ).run();
    await collector.collect({ market: "playerok", category: "accounts" });
    assert.deepEqual(calls, ["g2g", "playerok"]);
    assert.equal(collector.status().total, 1);
  } finally {
    collector.stop();
    db.close();
  }
});

test("different hosts start concurrently and FunPay verification never blocks collection completion", async () => {
  const db = createDatabase(),
    calls = [];
  db.prepare(
    "UPDATE categories SET enabled=0 WHERE id NOT IN ('accounts','ggsel-accounts','plati-accounts')",
  ).run();
  let releaseFetch, releaseVerify;
  const fetchGate = new Promise((resolve) => (releaseFetch = resolve)),
    verifyGate = new Promise((resolve) => (releaseVerify = resolve));
  const collector = createCollector(db, {
    fetchExternal: async (c) => {
      calls.push(c.platform);
      await fetchGate;
      return { offers: [offer(c.platform)] };
    },
    fetchPublic: async () => {
      calls.push("funpay");
      await fetchGate;
      return { offers: [offer("funpay")] };
    },
    verify: async () => {
      await verifyGate;
      return { checked: 0, left: 0 };
    },
    pauseMs: 0,
  });
  try {
    const collecting = collector.collect();
    assert.deepEqual(new Set(calls), new Set(["funpay", "ggsel", "plati"]));
    releaseFetch();
    await collecting;
    assert.equal(collector.status().running, false);
    assert.equal(collector.status().verifying, true);
    assert.equal(collector.status().completed, 3);
    releaseVerify();
    await collector.settled();
    assert.equal(collector.status().verifying, false);
  } finally {
    releaseFetch();
    releaseVerify();
    collector.stop();
    await collector.settled();
    db.close();
  }
});

test("existing external snapshots receive new fields without replacing explicit imported values or changing FunPay", () => {
  const db = createDatabase();
  try {
    saveSnapshot(db, "g2g-accounts", [
      {
        ...offer("g2g:1", { solommr: "3333" }),
        title: "2529 MMR | Behavior 8763",
      },
    ]);
    saveSnapshot(db, "accounts", [{ ...offer("funpay:1"), title: "2529 MMR" }]);
    db.prepare("DELETE FROM settings WHERE key='externalFieldsVersion'").run();
    backfillExternalFields(db);
    assert.equal(analyze(db, q()).offers[0].attributes.solommr, "3333");
    assert.equal(analyze(db, q()).offers[0].attributes.decency, "8763");
    assert.equal(
      analyze(db, q({ market: "funpay" })).offers[0].attributes.solommr,
      undefined,
    );
  } finally {
    db.close();
  }
});

test("Eldorado filters include explicit lower bounds and contained ranges without fabricating exact numbers", () => {
  const db = createDatabase();
  try {
    const attributes = externalAttributes(
      "Guardian · Rank Ready | Behavior10000+ | 3000+ Hours",
    );
    assert.equal(attributes.decency, undefined);
    assert.equal(attributes.decency_min, "10000");
    assert.equal(attributes.time_min, "3000");
    assert.equal(attributes.type, "с рейтингом");
    saveSnapshot(db, "eldorado-accounts", [
      offer("one", attributes),
      offer(
        "two",
        externalAttributes("Uncalibrated · Behavior6000+ | 1000-2000 MMR"),
      ),
    ]);
    const query = q({
      market: "eldorado",
      decencyMin: 10000,
      hoursMin: 2000,
      accountType: "ranked",
    });
    assert.equal(analyze(db, query).stats.count, 1);
    assert.equal(exportRows(db, query).length, 1);
    assert.equal(
      analyze(db, q({ market: "eldorado", decencyMax: 12000 })).stats.count,
      0,
    );
    assert.equal(
      analyze(db, q({ market: "eldorado", mmrMin: 1000, mmrMax: 2000 })).stats
        .count,
      1,
    );
    assert.equal(
      analyze(db, q({ market: "eldorado", mmrMin: 1500, mmrMax: 2000 })).stats
        .count,
      0,
    );
    assert.equal(
      analyze(db, q({ market: "eldorado" })).availableFilters.decency,
      2,
    );
  } finally {
    db.close();
  }
});

test("retired marketplaces are absent from catalog, regional selections and accepted queries", () => {
  const db = createDatabase();
  try {
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM categories WHERE platform IN ('playerauctions','epicnpc')",
        )
        .get().n,
      0,
    );
    assert.throws(() => q({ market: "playerauctions" }));
    assert.throws(() => q({ market: "epicnpc" }));
  } finally {
    db.close();
  }
});

test("ranked filter requires explicit open access, not just MMR, rank medal or uncalibrated wording", () => {
  const db = createDatabase();
  try {
    const titles = [
      "6000 MMR · Rank Ready",
      "6000 MMR · Not Ranked Ready",
      "Immortal · 6000 MMR",
      "ОТКРЫТЫЙ РЕЙТИНГ | 5400-6000ммр",
      "6000 MMR | рейтинг закрыт",
      "Uncalibrated · 6000 MMR",
      "Uncalibrated · 6000 MMR · Rank Ready",
    ];
    saveSnapshot(
      db,
      "ggsel-accounts",
      titles.map((title, i) => ({
        ...offer(String(i), {
          ...externalAttributes(title),
          platform: "ggsel",
        }),
        title,
      })),
    );
    const query = q({ market: "ggsel", accountType: "ranked", mmrMin: 5400 });
    assert.deepEqual(
      analyze(db, query)
        .offers.map((o) => o.offer_id)
        .sort(),
      ["0", "3", "6"],
    );
    assert.equal(exportRows(db, query).length, 3);
    assert.equal(analyze(db, query).series[0].count, 3);
  } finally {
    db.close();
  }
});
