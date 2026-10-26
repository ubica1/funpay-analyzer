import {
  accountRanges,
  saleTypes,
  accountTypes,
  accountFilterDefaults,
  offerSort,
  attributeNumber,
  attributeText,
} from "./account-fields.mjs";
import { z } from "zod";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Неверная дата",
  );
const optionalNumber = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.coerce.number().min(0).max(1e9).optional(),
);
export const querySchema = z
  .object({
    source: z.enum(["live", "demo"]).default("live"),
    category: z.string().max(500).default("accounts"),
    from: date,
    to: date,
    q: z.string().max(200).default(""),
    min: z.coerce.number().min(0).default(0),
    max: z.coerce.number().min(0).default(1e12),
    reviews: z.coerce.number().int().min(0).default(0),
    online: z.enum(["all", "1"]).default("all"),
    attribute: z.string().max(100).default(""),
    value: z.string().max(200).default(""),
    saleType: z.enum(["all", "sale", "rent"]).default("all"),
    accountType: z
      .enum(["all", "ranked", "calibration", "unranked"])
      .default("all"),
    auto: z.enum(["all", "1"]).default("all"),
    mmrMin: optionalNumber,
    mmrMax: optionalNumber,
    decencyMin: optionalNumber,
    decencyMax: optionalNumber,
    politenessMin: optionalNumber,
    politenessMax: optionalNumber,
    gamesMin: optionalNumber,
    gamesMax: optionalNumber,
    hoursMin: optionalNumber,
    hoursMax: optionalNumber,
    sort: z
      .enum([
        "price_asc",
        "price_desc",
        "reviews_desc",
        "title",
        "mmr_asc",
        "mmr_desc",
        "decency_desc",
        "politeness_desc",
        "games_desc",
        "hours_desc",
      ])
      .default("price_asc"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .refine(
    (v) =>
      accountRanges.every(
        ([name]) =>
          v[`${name}Min`] == null ||
          v[`${name}Max`] == null ||
          v[`${name}Min`] <= v[`${name}Max`],
      ),
    "Нижняя граница параметра не должна превышать верхнюю",
  )
  .refine(
    (v) => v.from <= v.to && v.min <= v.max,
    "Проверьте границы периода и цены",
  )
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366,
    "Максимальный период — 367 дней",
  );
function selection(db, q, from = q.from, to = q.to) {
  const ids =
    q.category === "all"
      ? db
          .prepare("SELECT id FROM categories")
          .all()
          .map((c) => c.id)
      : q.category.split(",");
  const start = new Date(`${from}T00:00:00+03:00`).toISOString();
  const end = new Date(
    Date.parse(`${to}T00:00:00+03:00`) + 86400000,
  ).toISOString();
  const snaps = db
    .prepare(
      `SELECT * FROM snapshots WHERE category_id IN (${ids.map(() => "?").join(",")}) AND collected_at>=? AND collected_at<? ORDER BY collected_at`,
    )
    .all(...ids, start, end);
  const last = new Map();
  const days = new Map();
  for (const s of snaps) {
    last.set(s.category_id, s);
    const day = new Date(Date.parse(s.collected_at) + 10800000)
      .toISOString()
      .slice(0, 10);
    days.set(`${day}:${s.category_id}`, s);
  }
  return { snaps, latest: [...last.values()], daily: [...days.values()] };
}
function where(q, ids) {
  const clauses = [
    ids === null
      ? "1"
      : `snapshot_id IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})`,
    "price>=?",
    "price<=?",
    "reviews>=?",
  ];
  const args = [...(ids ?? []), q.min, q.max, q.reviews];
  if (q.q) {
    clauses.push("(title LIKE ? ESCAPE '\\' OR seller LIKE ? ESCAPE '\\')");
    const like = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(like, like);
  }
  if (q.online === "1") clauses.push("online=1");
  if (q.attribute && q.value) {
    clauses.push(
      "EXISTS(SELECT 1 FROM json_each(attributes) WHERE key=? AND value=?)",
    );
    args.push(q.attribute, q.value);
  }
  if (q.saleType && q.saleType !== "all") {
    clauses.push("attribute_text(attributes, 'type1') = ?");
    args.push(saleTypes[q.saleType]);
  }
  if (q.accountType && q.accountType !== "all") {
    clauses.push("attribute_text(attributes, 'type') = ?");
    args.push(accountTypes[q.accountType]);
  }
  if (q.auto === "1") clauses.push("json_extract(attributes, '$.auto') = '1'");
  for (const [name, field] of accountRanges) {
    if (q[`${name}Min`] != null) {
      clauses.push("attribute_number(attributes, ?) >= ?");
      args.push(field, q[`${name}Min`]);
    }
    if (q[`${name}Max`] != null) {
      clauses.push("attribute_number(attributes, ?) <= ?");
      args.push(field, q[`${name}Max`]);
    }
  }
  return { sql: clauses.join(" AND "), args };
}
const statsSql =
  "COUNT(*) count, median(price) median, AVG(price) average, MIN(price) minimum, MAX(price) maximum, p25(price) p25, p75(price) p75, COUNT(DISTINCT seller_id) sellers, SUM(online) online";
function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const saleWindows = [
  ["day", 1],
  ["week", 7],
  ["month", 30],
];
export function sales(db, q, now = Date.now()) {
  const ids =
    q.category === "all"
      ? db
          .prepare("SELECT id FROM categories")
          .all()
          .map((c) => c.id)
      : q.category.split(",");
  const since = new Date(now - 30 * 86400000).toISOString();
  const filters = where(q, null);
  const marks = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT f.*,c.name category,c.color FROM (SELECT sa.*,s.collected_at sold_at,s.category_id FROM sales sa JOIN snapshots s ON s.id=sa.snapshot_id WHERE sa.verified=1 AND s.category_id IN (${marks}) AND s.collected_at>=?) f JOIN categories c ON c.id=f.category_id WHERE ${filters.sql} ORDER BY f.sold_at DESC`,
    )
    .all(...ids, since, ...filters.args)
    .map((r) => ({
      offer_id: r.offer_id,
      title: r.title,
      price: r.price,
      seller_id: r.seller_id,
      seller: r.seller,
      url: r.url,
      category: r.category,
      color: r.color,
      sold_at: r.sold_at,
      kind: r.kind,
      mmr: attributeNumber(r.attributes, "solommr"),
      new_mmr: r.new_mmr,
      sale_type: attributeText(r.attributes, "type1"),
    }));
  const summary = Object.fromEntries(
    saleWindows.map(([key, days]) => {
      const from = new Date(now - days * 86400000).toISOString();
      const prices = rows.filter((r) => r.sold_at >= from).map((r) => r.price);
      return [
        key,
        {
          count: prices.length,
          median: median(prices),
          total: Math.round(prices.reduce((a, b) => a + b, 0) * 100) / 100,
        },
      ];
    }),
  );
  const pairs = db
    .prepare(
      `SELECT COUNT(*) n, MIN(collected_at) first FROM snapshots WHERE category_id IN (${marks}) AND collected_at>=?`,
    )
    .get(...ids, since);
  const pending = db
    .prepare(
      `SELECT COUNT(*) n FROM sales sa JOIN snapshots s ON s.id=sa.snapshot_id WHERE sa.verified IS NULL AND sa.attempts<3 AND s.category_id IN (${marks})`,
    )
    .get(...ids).n;
  return {
    summary,
    pending,
    list: rows.slice(0, 2000),
    snapshots: pairs.n,
    trackedSince: pairs.first,
  };
}
export function analyze(db, q) {
  const selected = selection(db, q);
  const current = where(
    q,
    selected.latest.map((s) => s.id),
  );
  const stats = db
    .prepare(`SELECT ${statsSql} FROM observations WHERE ${current.sql}`)
    .get(...current.args);
  const duration = Date.parse(q.to) - Date.parse(q.from) + 86400000;
  const before = selection(
    db,
    q,
    new Date(Date.parse(q.from) - duration).toISOString().slice(0, 10),
    new Date(Date.parse(q.from) - 86400000).toISOString().slice(0, 10),
  );
  const previousWhere = where(
    q,
    before.latest.map((s) => s.id),
  );
  const previous = db
    .prepare(`SELECT ${statsSql} FROM observations WHERE ${previousWhere.sql}`)
    .get(...previousWhere.args);
  const daily = where(
    q,
    selected.daily.map((s) => s.id),
  );
  const series = db
    .prepare(
      `SELECT date(s.collected_at,'+3 hours') day,s.category_id category,${statsSql} FROM observations JOIN snapshots s ON s.id=snapshot_id WHERE ${daily.sql} GROUP BY day,s.category_id ORDER BY day`,
    )
    .all(...daily.args);
  const rows = db
    .prepare(`SELECT price FROM observations WHERE ${current.sql}`)
    .all(...current.args);
  const span = (stats.maximum ?? 0) - (stats.minimum ?? 0);
  const histogram = Array.from({ length: 8 }, (_, i) => ({
    from: (stats.minimum ?? 0) + (span * i) / 8,
    to: (stats.minimum ?? 0) + (span * (i + 1)) / 8,
    count: 0,
  }));
  for (const row of rows) {
    histogram[
      span
        ? Math.min(7, Math.floor(((row.price - stats.minimum) / span) * 8))
        : 0
    ].count++;
  }
  const sort = offerSort(q.sort);
  const page = Math.min(q.page, Math.max(1, Math.ceil(stats.count / 12)));
  const offers = db
    .prepare(
      `SELECT o.*,c.name category,c.color,s.collected_at FROM observations o JOIN snapshots s ON s.id=o.snapshot_id JOIN categories c ON c.id=s.category_id WHERE ${current.sql} ORDER BY ${sort} LIMIT 12 OFFSET ?`,
    )
    .all(...current.args, (page - 1) * 12)
    .map((o) => ({ ...o, attributes: JSON.parse(o.attributes) }));
  const saleStats = sales(db, q);
  const soldBy = new Map();
  for (const sale of saleStats.list) {
    const entry = soldBy.get(sale.seller_id) ?? {
      seller: sale.seller,
      prices: [],
    };
    entry.prices.push(sale.price);
    soldBy.set(sale.seller_id, entry);
  }
  const listed = db
    .prepare(
      `SELECT seller_id,seller,COUNT(*) count,median(price) median,MIN(price) minimum,MAX(reviews) reviews,MAX(online) online FROM observations WHERE ${current.sql} GROUP BY seller_id`,
    )
    .all(...current.args);
  const sellerRows = new Map(
    listed.map((s) => [s.seller_id, { ...s, sold: 0, soldMedian: null }]),
  );
  for (const [id, entry] of soldBy) {
    const row = sellerRows.get(id) ?? {
      seller_id: id,
      seller: entry.seller,
      count: 0,
      median: null,
      minimum: null,
      reviews: null,
      online: null,
    };
    sellerRows.set(id, {
      ...row,
      sold: entry.prices.length,
      soldMedian: median(entry.prices),
    });
  }
  // Cheapest lot under the current filters first; sellers with only past
  // sales (nothing listed now) go last.
  const sellers = [...sellerRows.values()].sort(
    (a, b) =>
      (a.minimum ?? Infinity) - (b.minimum ?? Infinity) ||
      b.sold - a.sold ||
      b.count - a.count,
  );
  const comparison = db
    .prepare(
      `SELECT s.category_id category,${statsSql} FROM observations JOIN snapshots s ON s.id=snapshot_id WHERE ${current.sql} GROUP BY s.category_id`,
    )
    .all(...current.args);
  const facetWhere = where(
    {
      ...q,
      ...accountFilterDefaults,
      q: "",
      min: 0,
      max: 1e12,
      reviews: 0,
      online: "all",
      attribute: "",
      value: "",
    },
    selected.latest.map((s) => s.id),
  );
  const facets = db
    .prepare(
      `WITH values_list AS (SELECT DISTINCT j.key,j.value FROM observations,json_each(attributes) j WHERE ${facetWhere.sql}), ranked AS (SELECT key,value,ROW_NUMBER() OVER (PARTITION BY key ORDER BY value) position FROM values_list) SELECT key,value FROM ranked WHERE position<=60 ORDER BY key,value`,
    )
    .all(...facetWhere.args);
  const coverage = selected.latest.map((s) => ({
    ...s,
    name: db
      .prepare("SELECT name FROM categories WHERE id=?")
      .get(s.category_id)?.name,
  }));
  const missing = (
    q.category === "all"
      ? db
          .prepare("SELECT id FROM categories WHERE enabled=1")
          .all()
          .map((x) => x.id)
      : q.category.split(",")
  ).filter((id) => !selected.latest.some((s) => s.category_id === id));
  return {
    stats,
    previous,
    series,
    histogram,
    offers,
    sellers,
    comparison,
    facets,
    coverage,
    missing,
    page,
    pages: Math.max(1, Math.ceil(stats.count / 12)),
    snapshots: selected.snaps.length,
    sales: saleStats,
    timezone: "Europe/Moscow",
  };
}
// One seller within the current category, period and lot filters.
export function sellerDetail(db, q, sellerId) {
  const selected = selection(db, q);
  const all = where(
    q,
    selected.snaps.map((s) => s.id),
  );
  const own = `${all.sql} AND seller_id=?`;
  const series = db
    .prepare(
      `SELECT s.collected_at,COUNT(*) count,median(price) median,MIN(price) minimum FROM observations JOIN snapshots s ON s.id=snapshot_id WHERE ${own} GROUP BY s.id ORDER BY s.collected_at`,
    )
    .all(...all.args, sellerId);
  const current = where(
    q,
    selected.latest.map((s) => s.id),
  );
  const lots = db
    .prepare(
      `SELECT o.*,s.collected_at FROM observations o JOIN snapshots s ON s.id=o.snapshot_id WHERE ${current.sql} AND seller_id=? ORDER BY price LIMIT 200`,
    )
    .all(...current.args, sellerId)
    .map((o) => ({
      ...o,
      attributes: JSON.parse(o.attributes),
      mmr: attributeNumber(o.attributes, "solommr"),
    }));
  const sold = sales(db, q).list.filter((s) => s.seller_id === sellerId);
  const name =
    lots[0]?.seller ??
    sold[0]?.seller ??
    db
      .prepare("SELECT seller FROM observations WHERE seller_id=? LIMIT 1")
      .get(sellerId)?.seller ??
    sellerId;
  return {
    seller_id: sellerId,
    seller: name,
    series,
    lots,
    sales: sold,
    soldMedian: median(sold.map((s) => s.price)),
  };
}
export function exportRows(db, q) {
  const w = where(
    q,
    selection(db, q).latest.map((s) => s.id),
  );
  return db
    .prepare(
      `SELECT s.collected_at,c.name category,o.offer_id,o.title,o.price,o.seller,o.reviews,o.online,o.attributes,o.url FROM observations o JOIN snapshots s ON s.id=o.snapshot_id JOIN categories c ON c.id=s.category_id WHERE ${w.sql} ORDER BY ${offerSort(q.sort)}`,
    )
    .all(...w.args)
    .map((row) => ({
      ...row,
      mmr: attributeNumber(row.attributes, "solommr"),
      sale_type: attributeText(row.attributes, "type1"),
      account_type: attributeText(row.attributes, "type"),
      decency: attributeNumber(row.attributes, "decency"),
      politeness: attributeNumber(row.attributes, "politeness"),
      games: attributeNumber(row.attributes, "games"),
      hours: attributeNumber(row.attributes, "time"),
      auto: attributeText(row.attributes, "auto"),
    }));
}
export function csv(rows) {
  const keys = [
    "collected_at",
    "category",
    "offer_id",
    "title",
    "price",
    "seller",
    "reviews",
    "online",
    "mmr",
    "sale_type",
    "account_type",
    "decency",
    "politeness",
    "games",
    "hours",
    "auto",
    "attributes",
    "url",
  ];
  const escape = (v) => {
    let s = String(v ?? "");
    if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      keys.join(";"),
      ...rows.map((r) => keys.map((k) => escape(r[k])).join(";")),
    ].join("\r\n")
  );
}
