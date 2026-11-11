import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, saveSnapshot, seedDemo } from "../server/db.mjs";
import {
  analyze,
  querySchema,
  exportRows,
  sellerDetail,
  sales,
} from "../server/analytics.mjs";
import { parseExternalOffers } from "../server/external-collector.mjs";
import { platforms } from "../server/platforms.mjs";
import { createApp } from "../server/index.mjs";
const query = (extra) =>
  querySchema.parse({ from: "2026-10-01", to: "2026-10-31", ...extra });
const lot = (platform, price, seller = "1") => ({
  id: `${platform}:1`,
  title: "Dota 2 account",
  price,
  sellerId: `${platform}:${seller}`,
  seller: "Seller",
  reviews: 0,
  online: false,
  attributes: {},
  url: platforms.find((p) => p.id === platform).url,
});

test("platform and regional selection isolate currencies in statistics, history, sellers and export", () => {
  const db = createDatabase();
  try {
    for (const [platform, price] of [
      ["funpay", 1000],
      ["ggsel", 2000],
      ["eldorado", 10],
      ["g2g", 30],
    ]) {
      const category =
        platform === "funpay" ? "accounts" : `${platform}-accounts`;
      saveSnapshot(
        db,
        category,
        [lot(platform, price)],
        {},
        "2026-10-20T10:00:00.000Z",
      );
      saveSnapshot(
        db,
        category,
        [lot(platform, price * 2)],
        {},
        "2026-10-21T10:00:00.000Z",
      );
    }
    const ru = analyze(db, query({ market: "ru" }));
    assert.equal(ru.stats.count, 2);
    assert.equal(ru.stats.median, 3000);
    assert.equal(ru.currency, "RUB");
    assert.equal(ru.stats.sellers, 2);
    assert.equal(ru.series.length, 4);
    assert.ok(ru.missing.includes("playerok-accounts"));
    const foreign = analyze(db, query({ market: "foreign" }));
    assert.equal(foreign.currency, "USD");
    assert.equal(foreign.stats.median, 40);
    assert.equal(exportRows(db, query({ market: "foreign" })).length, 2);
    assert.ok(
      exportRows(db, query({ market: "foreign" })).every(
        (o) => o.currency === "USD",
      ),
    );
    assert.equal(analyze(db, query({ market: "g2g" })).stats.count, 1);
    assert.equal(
      analyze(
        db,
        query({ market: "foreign", category: "accounts,ggsel-accounts" }),
      ).stats.count,
      2,
    );
    assert.equal(
      analyze(db, query({ market: "foreign", category: "ggsel-accounts" }))
        .stats.count,
      0,
    );
    assert.equal(
      sellerDetail(db, query({ market: "ru" }), "g2g:1").lots.length,
      0,
    );
    assert.equal(analyze(db, query()).stats.count, 1);
    assert.throws(() => query({ market: "all" }));
  } finally {
    db.close();
  }
});

test("external products are namespaced and currency mismatches, aggregates and unsafe links excluded", () => {
  const product = (url, currency = "USD") => ({
    "@type": "Product",
    name: "Account",
    url,
    offers: {
      "@type": "Offer",
      price: "25.50",
      priceCurrency: currency,
      seller: { name: "Seller" },
    },
  });
  const data = [
    product("https://www.eldorado.gg/account/one"),
    product("https://www.eldorado.gg/account/one"),
    product("https://www.eldorado.gg/account/two", "EUR"),
    product("https://evil.example/test"),
    {
      "@type": "Product",
      name: "Category",
      offers: { "@type": "AggregateOffer", lowPrice: 1, priceCurrency: "USD" },
    },
  ];
  const html = `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
  const result = parseExternalOffers(html, "eldorado");
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].price, 25.5);
  assert.equal(result.offers[0].sellerId, "eldorado:Seller");
  assert.equal(result.offers[0].attributes.solommr, undefined);
  assert.throws(() =>
    parseExternalOffers("<title>Just a moment</title>", "eldorado"),
  );
  assert.throws(() => parseExternalOffers("<html>Loading</html>", "playerok"));
});

test("demo has distinct accounts for all marketplaces without creating inferred external sales", () => {
  const db = createDatabase();
  try {
    seedDemo(db);
    const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
    for (const p of platforms)
      assert.ok(
        analyze(db, querySchema.parse({ from: today, to: today, market: p.id }))
          .stats.count > 0,
        p.id,
      );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM sales sa JOIN snapshots s ON s.id=sa.snapshot_id JOIN categories c ON c.id=s.category_id WHERE c.platform!='funpay'",
        )
        .get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test("snapshot import validates currency, namespaces IDs and persists only valid listings", async () => {
  const instance = createApp({ db: createDatabase(), startSchedule: false });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const post = (body) =>
      fetch(`http://127.0.0.1:${server.address().port}/api/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "MarketLens",
        },
        body: JSON.stringify(body),
      });
    const data = {
      platform: "eldorado",
      currency: "USD",
      offers: [
        {
          url: "https://www.eldorado.gg/account/one",
          title: "Dota 2 account",
          price: 25,
          seller: "Seller",
          sellerId: "1",
        },
      ],
    };
    assert.equal((await post({ ...data, currency: "RUB" })).status, 400);
    assert.equal(
      (
        await post({
          ...data,
          offers: [{ ...data.offers[0], url: "https://evil.example/one" }],
        })
      ).status,
      400,
    );
    assert.equal(
      instance.db.prepare("SELECT COUNT(*) n FROM snapshots").get().n,
      0,
    );
    assert.equal((await post(data)).status, 201);
    assert.equal(
      instance.db.prepare("SELECT seller_id FROM observations").get().seller_id,
      "eldorado:1",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    instance.close();
  }
});

test("existing FunPay database is migrated without dropping categories, snapshots or offers", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "marketlens-migration-"));
  const path = join(dir, "old.sqlite");
  let db = createDatabase(path);
  saveSnapshot(
    db,
    "accounts",
    [lot("funpay", 1700)],
    {},
    "2026-10-20T10:00:00.000Z",
  );
  db.close();
  const old = new DatabaseSync(path);
  old.exec(
    "ALTER TABLE categories DROP COLUMN platform; ALTER TABLE categories DROP COLUMN kind;",
  );
  old.close();
  try {
    db = createDatabase(path);
    assert.equal(analyze(db, query()).stats.median, 1700);
    assert.equal(
      db.prepare("SELECT platform FROM categories WHERE id='accounts'").get()
        .platform,
      "funpay",
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM categories").get().n, 15);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external sale evidence requires two misses, distinguishes sample exits and is withdrawn on return", () => {
  const db = createDatabase();
  try {
    const at = (day) => `2026-10-${day}T10:00:00.000Z`;
    const now = Date.parse(at(24));
    for (const [platform, full] of [
      ["playerauctions", true],
      ["ggsel", false],
    ]) {
      const category = `${platform}-accounts`;
      const a = { ...lot(platform, 10), id: `${platform}:a`, title: "A" };
      const b = { ...lot(platform, 20), id: `${platform}:b`, title: "B" };
      const first = full
        ? [a, b]
        : [
            a,
            b,
            ...Array.from({ length: 3 }, (_, i) => ({
              ...b,
              id: `${platform}:extra${i}`,
            })),
          ];
      const rest = first.slice(1);
      const save = (offers, day) =>
        saveSnapshot(
          db,
          category,
          offers,
          full ? { advertised: offers.length } : {},
          at(day),
        );
      save(first, 20);
      save(rest, 21);
      assert.equal(sales(db, query({ market: platform }), now).list.length, 0);
      save(rest, 22);
      const result = sales(db, query({ market: platform }), now);
      assert.equal(result.list.length, full ? 1 : 0);
      assert.equal(result.sampleExits.length, full ? 0 : 1);
      assert.equal(result.summary.month.total, full ? 10 : 0);
      assert.equal(
        (result.list[0] ?? result.sampleExits[0]).platform,
        platform,
      );
      save(first, 23);
      const returned = sales(db, query({ market: platform }), now);
      assert.equal(returned.list.length + returned.sampleExits.length, 0);
    }
  } finally {
    db.close();
  }
});
