import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, saveSnapshot, settings } from "../server/db.mjs";
import { parseOffers, categoryUrl } from "../server/collector.mjs";
import { analyze, querySchema, csv, exportRows } from "../server/analytics.mjs";
import { createApp } from "../server/index.mjs";
const offer = (id, price, extra = {}) => ({
  id,
  title: `Аккаунт ${id}`,
  price,
  seller: "Seller",
  sellerId: "1",
  reviews: 120,
  online: true,
  attributes: { mmr: "4000", region: "EU" },
  url: `https://funpay.com/lots/offer?id=${id}`,
  ...extra,
});
const q = (extra) =>
  querySchema.parse({ from: "2026-10-01", to: "2026-10-07", ...extra });
test("median, quantiles and unique sellers use latest snapshot, not duplicated history", () => {
  const db = createDatabase();
  try {
    saveSnapshot(
      db,
      "accounts",
      [offer("1", 10)],
      {},
      "2026-10-01T08:00:00.000Z",
    );
    saveSnapshot(
      db,
      "accounts",
      [
        offer("1", 100),
        offer("2", 200),
        offer("3", 300),
        offer("4", 1000, { sellerId: "2" }),
      ],
      {},
      "2026-10-07T08:00:00.000Z",
    );
    const d = analyze(db, q());
    assert.equal(d.stats.count, 4);
    assert.equal(d.stats.median, 250);
    assert.equal(d.stats.p25, 175);
    assert.equal(d.stats.p75, 475);
    assert.equal(d.stats.sellers, 2);
    assert.equal(d.series.length, 2);
    assert.equal(d.previous.median, null);
  } finally {
    db.close();
  }
});
test("all filters apply to stats, chart, sellers, offers and export", () => {
  const db = createDatabase();
  try {
    saveSnapshot(db, "accounts", [
      offer("1", 100),
      offer("2", 200, { online: false }),
      offer("3", 300, { reviews: 1 }),
      offer("4", 400, { attributes: { region: "RU" } }),
    ]);
    const query = q({ from: "2020-01-01", to: "2020-01-02" });
    assert.equal(analyze(db, query).stats.count, 0);
    const now = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
    const filtered = q({
      from: now,
      to: now,
      online: "1",
      reviews: 100,
      attribute: "region",
      value: "EU",
      max: 350,
      q: "Аккаунт",
    });
    const d = analyze(db, filtered);
    assert.equal(d.stats.count, 1);
    assert.equal(d.offers[0].offer_id, "1");
    assert.equal(d.series[0].median, 100);
    assert.equal(d.sellers[0].count, 1);
    assert.equal(exportRows(db, filtered).length, 1);
  } finally {
    db.close();
  }
});
test("day grouping and range boundaries use Moscow time; choose final snapshot each day", () => {
  const db = createDatabase();
  try {
    saveSnapshot(
      db,
      "accounts",
      [offer("1", 10)],
      {},
      "2026-09-30T20:59:59.000Z",
    );
    saveSnapshot(
      db,
      "accounts",
      [offer("1", 20)],
      {},
      "2026-09-30T21:00:00.000Z",
    );
    saveSnapshot(
      db,
      "accounts",
      [offer("1", 30)],
      {},
      "2026-10-01T20:59:59.000Z",
    );
    saveSnapshot(
      db,
      "accounts",
      [offer("1", 40)],
      {},
      "2026-10-01T21:00:00.000Z",
    );
    const d = analyze(db, q({ to: "2026-10-01" }));
    assert.equal(d.snapshots, 2);
    assert.equal(d.series.length, 1);
    assert.equal(d.series[0].median, 30);
    assert.equal(d.previous.median, 10);
  } finally {
    db.close();
  }
});
test("multiple categories are compared using their own latest snapshots", () => {
  const db = createDatabase();
  try {
    saveSnapshot(
      db,
      "accounts",
      [offer("1", 100)],
      {},
      "2026-10-06T12:00:00.000Z",
    );
    saveSnapshot(
      db,
      "boost",
      [offer("2", 200)],
      {},
      "2026-10-07T12:00:00.000Z",
    );
    const d = analyze(db, q({ category: "all" }));
    assert.equal(d.stats.count, 2);
    assert.equal(d.comparison.length, 2);
    assert.equal(d.stats.sellers, 1);
    assert.ok(d.missing.includes("calibration"));
  } finally {
    db.close();
  }
});
test("snapshot atomicity, duplicate IDs, retention cascade", () => {
  const db = createDatabase();
  try {
    assert.throws(() => saveSnapshot(db, "accounts", []));
    assert.throws(() => saveSnapshot(db, "accounts", [offer("1", -10)]));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, 0);
    const id = saveSnapshot(db, "accounts", [offer("1", 10), offer("1", 20)]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM observations").get().n, 1);
    db.prepare("DELETE FROM snapshots WHERE id=?").run(id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM observations").get().n, 0);
  } finally {
    db.close();
  }
});
const fixture = `<html><title>Калибровка Dota 2</title><a class="counter-item active"><span class="counter-value">4 000</span></a><a class="tc-item" href="https://funpay.com/lots/offer?id=123" data-online="1" data-f-mmr="4000"><div class="tc-desc-text">Калибровка &amp; обучение</div><div class="media-user-name"> TestSeller </div><div data-href="https://funpay.com/users/456/"></div><span class="rating-mini-count">1 234</span><div class="tc-price" data-s="1249.999919">1250 <span class="unit">₽</span></div></a></html>`;
test("parser handles actual FunPay fields and incomplete coverage", () => {
  const result = parseOffers(fixture, "https://funpay.com/lots/500/");
  assert.equal(result.advertised, 4000);
  assert.equal(result.offers.length, 1);
  assert.deepEqual(
    result.offers[0],
    offer("123", 1250, {
      title: "Калибровка & обучение",
      seller: "TestSeller",
      sellerId: "456",
      reviews: 1234,
      attributes: { mmr: "4000" },
    }),
  );
});
test("parser deduplicates pinned offers repeated in the page", () => {
  const duplicated = fixture.replace(
    "</html>",
    fixture.match(/<a class="tc-item"[\s\S]*?<\/a>/)[0] + "</html>",
  );
  assert.equal(
    parseOffers(duplicated, "https://funpay.com/lots/500/").offers.length,
    1,
  );
});
test("parser rejects currency mismatch, challenge and changed markup", () => {
  assert.throws(() =>
    parseOffers(fixture.replace("₽", "$"), "https://funpay.com/lots/500/"),
  );
  assert.throws(() =>
    parseOffers("<title>Just a moment</title>", "https://funpay.com/lots/500/"),
  );
  assert.throws(() =>
    parseOffers("<html>empty</html>", "https://funpay.com/lots/500/"),
  );
});
test("only exact public FunPay category URLs are allowed", () => {
  assert.equal(
    categoryUrl("https://funpay.com/en/lots/81/"),
    "https://funpay.com/lots/81/",
  );
  for (const url of [
    "http://funpay.com/lots/81/",
    "https://evil.example/lots/81/",
    "https://funpay.com.evil.example/lots/81/",
    "https://funpay.com@127.0.0.1/lots/81/",
    "https://funpay.com/lots/81/?next=foo",
    "https://funpay.com:123/lots/81/",
    "https://funpay.com/users/1/",
  ])
    assert.throws(() => categoryUrl(url));
});
test("query bounds, calendar validation, literal wildcard search and pagination", () => {
  for (const extra of [
    { from: "2026-02-30" },
    { from: "2026-10-08" },
    { min: 100, max: 1 },
    { page: 0 },
    { from: "2020-01-01" },
    { sort: "price;DROP TABLE snapshots" },
  ])
    assert.throws(() => q(extra));
  const db = createDatabase();
  try {
    saveSnapshot(
      db,
      "accounts",
      Array.from({ length: 15 }, (_, i) => offer(String(i), i + 1)),
      {},
      "2026-10-01T08:00:00.000Z",
    );
    assert.equal(analyze(db, q({ q: "%" })).stats.count, 0);
    assert.equal(analyze(db, q({ page: 999 })).page, 2);
    assert.equal(analyze(db, q({ page: 2 })).offers.length, 3);
  } finally {
    db.close();
  }
});
test("CSV quotes values, protects spreadsheet formulas, has UTF-8 BOM", () => {
  const output = csv([
    { title: '=HYPERLINK("evil")', seller: "line\nbreak", price: 123 },
  ]);
  assert.ok(output.startsWith("\uFEFF"));
  assert.ok(output.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(output.includes('"line\nbreak"'));
});
test("API validates writes, rejects cross-origin requests, persists settings and serves filtered data", async () => {
  const db = createDatabase();
  const app = createApp({ db, startSchedule: false });
  const server = app.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "MarketLens",
  };
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const payload = {
      intervalMinutes: 60,
      retentionDays: 30,
      scheduled: false,
    };
    assert.equal(
      (
        await fetch(`${base}/api/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/settings`, {
          method: "PATCH",
          headers: { ...headers, Origin: "https://evil.example" },
          body: JSON.stringify(payload),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/settings`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...payload, intervalMinutes: 1 }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/settings`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...payload, intervalMinutes: 120 }),
        })
      ).status,
      200,
    );
    assert.equal(settings(db).intervalMinutes, 120);
    assert.equal(
      (
        await fetch(`${base}/api/categories/missing`, {
          method: "PATCH",
          headers,
          body: '{"enabled":true}',
        })
      ).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/analytics?from=2026-10-01&to=2026-10-07`))
        .status,
      200,
    );
    const demoTo = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
    const demoFrom = new Date(Date.now() - 29 * 86400000 + 10800000)
      .toISOString()
      .slice(0, 10);
    const demo = await (
      await fetch(
        `${base}/api/analytics?source=demo&category=all&from=${demoFrom}&to=${demoTo}`,
      )
    ).json();
    assert.ok(demo.stats.count > 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, 0);
  } finally {
    await new Promise((r) => server.close(r));
    app.close();
  }
});
test("HTTP Basic access is required when configured", async () => {
  const old = process.env.ANALYZER_PASSWORD;
  process.env.ANALYZER_PASSWORD = "test-secret";
  const app = createApp({ db: createDatabase(), startSchedule: false });
  if (old === undefined) delete process.env.ANALYZER_PASSWORD;
  else process.env.ANALYZER_PASSWORD = old;
  const server = app.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/health`, {
          headers: {
            Authorization: `Basic ${Buffer.from("admin:test-secret").toString("base64")}`,
          },
        })
      ).status,
      200,
    );
  } finally {
    await new Promise((r) => server.close(r));
    app.close();
  }
});
