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
    sort: z
      .enum(["price_asc", "price_desc", "reviews_desc", "title"])
      .default("price_asc"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
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
    `snapshot_id IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})`,
    "price>=?",
    "price<=?",
    "reviews>=?",
  ];
  const args = [...ids, q.min, q.max, q.reviews];
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
  return { sql: clauses.join(" AND "), args };
}
const statsSql =
  "COUNT(*) count, median(price) median, AVG(price) average, MIN(price) minimum, MAX(price) maximum, p25(price) p25, p75(price) p75, COUNT(DISTINCT seller_id) sellers, SUM(online) online";
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
  const sort = {
    price_asc: "price ASC,offer_id",
    price_desc: "price DESC,offer_id",
    reviews_desc: "reviews DESC,price",
    title: "title,offer_id",
  }[q.sort];
  const page = Math.min(q.page, Math.max(1, Math.ceil(stats.count / 12)));
  const offers = db
    .prepare(
      `SELECT o.*,c.name category,c.color,s.collected_at FROM observations o JOIN snapshots s ON s.id=o.snapshot_id JOIN categories c ON c.id=s.category_id WHERE ${current.sql} ORDER BY ${sort} LIMIT 12 OFFSET ?`,
    )
    .all(...current.args, (page - 1) * 12)
    .map((o) => ({ ...o, attributes: JSON.parse(o.attributes) }));
  const sellers = db
    .prepare(
      `SELECT seller_id,seller,COUNT(*) count,median(price) median,MAX(reviews) reviews,MAX(online) online FROM observations WHERE ${current.sql} GROUP BY seller_id ORDER BY count DESC LIMIT 12`,
    )
    .all(...current.args);
  const comparison = db
    .prepare(
      `SELECT s.category_id category,${statsSql} FROM observations JOIN snapshots s ON s.id=snapshot_id WHERE ${current.sql} GROUP BY s.category_id`,
    )
    .all(...current.args);
  const facetWhere = where(
    {
      ...q,
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
      `SELECT DISTINCT j.key,j.value FROM observations,json_each(attributes) j WHERE ${facetWhere.sql} ORDER BY j.key,j.value LIMIT 300`,
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
    timezone: "Europe/Moscow",
  };
}
export function exportRows(db, q) {
  const w = where(
    q,
    selection(db, q).latest.map((s) => s.id),
  );
  return db
    .prepare(
      `SELECT s.collected_at,c.name category,o.offer_id,o.title,o.price,o.seller,o.reviews,o.online,o.attributes,o.url FROM observations o JOIN snapshots s ON s.id=o.snapshot_id JOIN categories c ON c.id=s.category_id WHERE ${w.sql} ORDER BY price`,
    )
    .all(...w.args);
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
