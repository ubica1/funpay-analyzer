import { attributeNumber, attributeText } from "./account-fields.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const categories = [
  ["accounts", "Аккаунты", 81, 1, "#71d9b0"],
  ["boost", "Буст MMR", 82, 1, "#a49bfa"],
  ["calibration", "Калибровка", 500, 1, "#f6bd73"],
  ["items", "Предметы", 210, 0, "#74b9f0"],
  ["low-priority", "Отмыв ЛП", 501, 0, "#eb91ad"],
  ["coaching", "Обучение", 502, 0, "#b9cb80"],
  ["dota-plus", "Услуги Dota+", 503, 0, "#91acb8"],
  ["vhs", "Привязки VHS", 867, 0, "#d5a1ed"],
];
export function createDatabase(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, color TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id), collected_at TEXT NOT NULL, total INTEGER NOT NULL, advertised INTEGER, coverage REAL, skipped INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(category_id,collected_at);
    CREATE TABLE IF NOT EXISTS observations(snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, offer_id TEXT NOT NULL, title TEXT NOT NULL, price REAL NOT NULL CHECK(price>=0), seller_id TEXT NOT NULL, seller TEXT NOT NULL, reviews INTEGER NOT NULL, online INTEGER NOT NULL, attributes TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY(snapshot_id,offer_id));
    CREATE INDEX IF NOT EXISTS observations_offer ON observations(offer_id,snapshot_id);
    CREATE INDEX IF NOT EXISTS observations_seller ON observations(snapshot_id,seller_id);
    CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, category_id TEXT, status TEXT NOT NULL, message TEXT NOT NULL, count INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const put = db.prepare("INSERT OR IGNORE INTO categories VALUES(?,?,?,?,?)");
  for (const [id, name, node, enabled, color] of categories)
    put.run(id, name, `https://funpay.com/lots/${node}/`, enabled, color);
  for (const [key, value] of Object.entries({
    intervalMinutes: 60,
    retentionDays: 30,
    scheduled: false,
  }))
    db.prepare("INSERT OR IGNORE INTO settings VALUES(?,?)").run(
      key,
      JSON.stringify(value),
    );
  for (const [name, q] of [
    ["median", 0.5],
    ["p25", 0.25],
    ["p75", 0.75],
  ])
    db.aggregate(name, {
      start: () => [],
      step: (a, v) => {
        a.push(v);
        return a;
      },
      result: (a) => {
        if (!a.length) return null;
        a.sort((a, b) => a - b);
        const p = (a.length - 1) * q;
        return (
          a[Math.floor(p)] + (a[Math.ceil(p)] - a[Math.floor(p)]) * (p % 1)
        );
      },
    });
  db.function("attribute_number", { deterministic: true }, attributeNumber);
  db.function("attribute_text", { deterministic: true }, attributeText);
  const version = db
    .prepare("SELECT value FROM settings WHERE key='salesVersion'")
    .get();
  const stale = version?.value !== String(salesVersion);
  if (stale)
    db.exec(
      "DROP TABLE IF EXISTS sales; DELETE FROM settings WHERE key='salesBackfilled';",
    );
  db.exec(salesTable);
  if (stale) {
    // Recompute sales for snapshots saved before the current detection rules.
    for (const s of db
      .prepare(
        "SELECT id,category_id,collected_at FROM snapshots ORDER BY collected_at",
      )
      .all())
      recordSales(db, s.category_id, s.id, s.collected_at);
    db.prepare("INSERT OR REPLACE INTO settings VALUES('salesVersion',?)").run(
      String(salesVersion),
    );
  }
  return db;
}
export function settings(db) {
  return Object.fromEntries(
    db
      .prepare("SELECT * FROM settings")
      .all()
      .map((x) => [x.key, JSON.parse(x.value)]),
  );
}
export function saveSnapshot(
  db,
  categoryId,
  offers,
  meta = {},
  at = new Date().toISOString(),
) {
  if (!offers.length)
    throw new Error(
      "Пустая выборка: снимок не сохранён. Проверьте страницу и разметку.",
    );
  db.exec("BEGIN");
  try {
    const unique = [...new Map(offers.map((o) => [o.id, o])).values()];
    const result = db
      .prepare(
        "INSERT INTO snapshots(category_id,collected_at,total,advertised,coverage,skipped) VALUES(?,?,?,?,?,?)",
      )
      .run(
        categoryId,
        at,
        unique.length,
        meta.advertised ?? null,
        meta.advertised ? Math.min(1, unique.length / meta.advertised) : null,
        meta.skipped ?? 0,
      );
    const id = Number(result.lastInsertRowid);
    const stmt = db.prepare(
      "INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    for (const o of unique)
      stmt.run(
        id,
        o.id,
        o.title,
        o.price,
        o.sellerId,
        o.seller,
        o.reviews,
        o.online ? 1 : 0,
        JSON.stringify(o.attributes),
        o.url,
      );
    recordSales(db, categoryId, id, at);
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
const salesVersion = 4;
// verified: NULL while the lot page is not checked yet, 1 once FunPay reports
// the lot as removed. Lots found alive are deleted from the table.
const salesTable = `CREATE TABLE IF NOT EXISTS sales(snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, offer_id TEXT NOT NULL, title TEXT NOT NULL, price REAL NOT NULL, seller_id TEXT NOT NULL, seller TEXT NOT NULL, reviews INTEGER NOT NULL, online INTEGER NOT NULL, attributes TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL, new_mmr REAL, verified INTEGER, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(snapshot_id,offer_id));
  CREATE INDEX IF NOT EXISTS sales_pending ON sales(verified);`;
// A sale lot is a sale candidate when it vanishes between two consecutive
// snapshots of its category, unless its seller re-posted it under a new id
// with the same title and price. FunPay lists only part of a category and the
// set of sellers shown shifts, so every candidate is confirmed later by
// opening its page (see verifySales in collector.mjs). A lot that stays but
// whose account changes (MMR differs by 300 or more) counts right away.
// Only account sales are tracked: a rented lot hides and comes back, and a
// bought service (boost, calibration) usually stays listed.
function recordSales(db, categoryId, id, at) {
  const prev = db
    .prepare(
      "SELECT id FROM snapshots WHERE category_id=? AND collected_at<? ORDER BY collected_at DESC LIMIT 1",
    )
    .get(categoryId, at);
  if (!prev) return;
  const mmr = (alias) => `attribute_number(${alias}.attributes,'solommr')`;
  const forSale = "attribute_text(o.attributes,'type1')='продажа'";
  db.prepare(
    `INSERT OR IGNORE INTO sales SELECT ?,o.offer_id,o.title,o.price,o.seller_id,o.seller,o.reviews,o.online,o.attributes,o.url,'gone',NULL,NULL,0 FROM observations o
    WHERE o.snapshot_id=? AND ${forSale}
      AND NOT EXISTS(SELECT 1 FROM observations x WHERE x.snapshot_id=? AND x.offer_id=o.offer_id)
      AND NOT EXISTS(SELECT 1 FROM observations x WHERE x.snapshot_id=? AND x.seller_id=o.seller_id AND x.title=o.title AND x.price=o.price
        AND NOT EXISTS(SELECT 1 FROM observations y WHERE y.snapshot_id=? AND y.offer_id=x.offer_id))`,
  ).run(id, prev.id, id, id, prev.id);
  db.prepare(
    `INSERT OR IGNORE INTO sales SELECT ?,o.offer_id,o.title,o.price,o.seller_id,o.seller,o.reviews,o.online,o.attributes,o.url,'replaced',${mmr("x")},1,0 FROM observations o JOIN observations x ON x.snapshot_id=? AND x.offer_id=o.offer_id
    WHERE o.snapshot_id=? AND ${forSale} AND ABS(${mmr("o")}-${mmr("x")})>=300`,
  ).run(id, id, prev.id);
}

export function seedDemo(db) {
  let seed = 3457;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const sellers = [
    "MantaStore",
    "RadiantShop",
    "ImmortalHub",
    "DotaMarket",
    "AegisTrade",
    "MidOnly",
    "GoodGame",
    "LotusStore",
    "AncientLab",
    "CarryClub",
    "RoshanShop",
    "CrystalTrade",
  ];
  const ranks = [
    "1000–2000",
    "2000–3000",
    "3000–4000",
    "4000–5000",
    "5000–6000",
    "6000–7000",
  ];
  const bases = [2200, 750, 1600, 390, 180, 650, 450, 1200];
  for (let day = 29; day >= 0; day--) {
    const moscowToday = new Date(Date.now() + 10800000)
      .toISOString()
      .slice(0, 10);
    const at = new Date(`${moscowToday}T08:00:00.000Z`);
    at.setUTCDate(at.getUTCDate() - day);
    if (at > new Date()) at.setTime(Date.now() - 60000);
    categories.forEach(([id, name], ci) => {
      const offers = [];
      for (let i = 0; i < 95 + Math.round(18 * Math.sin(day / 4 + ci)); i++) {
        const rank = ranks[i % ranks.length];
        const seller = sellers[i % sellers.length];
        offers.push({
          id: `demo-${ci}-${i}`,
          title:
            ci === 0
              ? `Аккаунт Dota 2 · ${i % 11 ? `${1000 + (i % 20) * 500} MMR` : "MMR не указан"} · ${i % 5 === 0 ? "Аренда" : "Продажа"} · ${i % 2 ? "EU" : "RU"}`
              : `${name} · ${rank} MMR · ${i % 2 ? "EU" : "RU"}`,
          price: Math.round(
            bases[ci] * (0.35 + (i % 19) / 9) * (1 + (29 - day) * 0.004) +
              rand() * 80,
          ),
          sellerId: `demo-s${i % sellers.length}`,
          seller,
          reviews: 40 + (i % sellers.length) * 127,
          online: rand() > 0.38,
          attributes:
            ci === 0
              ? {
                  ...(i % 11 ? { solommr: String(1000 + (i % 20) * 500) } : {}),
                  type1: i % 5 === 0 ? "аренда" : "продажа",
                  ...(i % 5
                    ? {
                        type: [
                          "с рейтингом",
                          "под калибровку (tbd)",
                          "без доступа к рейтинговым играм",
                        ][i % 3],
                      }
                    : {}),
                  decency: String(6000 + (i % 7) * 1000),
                  politeness: String(7000 + (i % 6) * 1000),
                  games: String(100 + i * 17),
                  time: String(100 + i * 13),
                  auto: i % 4 ? "1" : "0",
                  region: i % 2 ? "EU" : "RU",
                }
              : { mmr: rank, region: i % 2 ? "EU" : "RU" },
          url: "https://funpay.com/",
        });
      }
      saveSnapshot(
        db,
        id,
        offers,
        { advertised: offers.length },
        at.toISOString(),
      );
    });
  }
  db.exec("UPDATE sales SET verified=1");
}
