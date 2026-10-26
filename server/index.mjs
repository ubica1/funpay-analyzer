import express from "express";
import { z } from "zod";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createDatabase, seedDemo, settings } from "./db.mjs";
import { categoryUrl, createCollector } from "./collector.mjs";
import {
  analyze,
  querySchema,
  exportRows,
  csv,
  sellerDetail,
} from "./analytics.mjs";

export function createApp({
  db = createDatabase(process.env.DATABASE_PATH ?? "data/market.sqlite"),
  startSchedule = true,
} = {}) {
  const app = express();
  const collector = createCollector(db);
  let demo;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
    });
    next();
  });
  const password = process.env.ANALYZER_PASSWORD;
  const user = process.env.ANALYZER_USER ?? "admin";
  if (process.env.NODE_ENV === "production" && !password)
    throw new Error("В production задайте ANALYZER_PASSWORD.");
  if (password)
    app.use((req, res, next) => {
      const raw = req.headers.authorization ?? "";
      const actual = raw.startsWith("Basic ")
        ? Buffer.from(raw.slice(6), "base64")
        : Buffer.alloc(0);
      const expected = Buffer.from(`${user}:${password}`);
      if (
        actual.length === expected.length &&
        timingSafeEqual(actual, expected)
      )
        return next();
      res
        .set("WWW-Authenticate", 'Basic realm="Market Lens", charset="UTF-8"')
        .status(401)
        .send("Требуется вход");
    });
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method)) {
      if (req.headers["x-requested-with"] !== "MarketLens")
        return res.status(403).json({ error: "Недопустимый запрос" });
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      )
        return res.status(403).json({ error: "Недопустимый Origin" });
    }
    next();
  });
  const source = (q) => {
    if (q.source !== "demo") return db;
    if (!demo) {
      demo = createDatabase();
      seedDemo(demo);
    }
    return demo;
  };
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.get("/api/bootstrap", (req, res) =>
    res.json({
      categories: db
        .prepare(
          "SELECT c.*, (SELECT MAX(collected_at) FROM snapshots WHERE category_id=c.id) lastCollected FROM categories c",
        )
        .all(),
      settings: settings(db),
      collector: collector.status(),
      runs: db
        .prepare(
          "SELECT r.*,c.name category FROM runs r LEFT JOIN categories c ON c.id=r.category_id ORDER BY r.id DESC LIMIT 50",
        )
        .all(),
      hasData: !!db.prepare("SELECT 1 FROM snapshots LIMIT 1").get(),
    }),
  );
  app.get("/api/analytics", (req, res) => {
    const q = querySchema.parse(req.query);
    res.json(analyze(source(q), q));
  });
  app.get("/api/export", (req, res) => {
    const q = querySchema.parse(req.query);
    res
      .set("Content-Type", "text/csv; charset=utf-8")
      .attachment(`funpay-${q.source}-${q.from}-${q.to}.csv`)
      .send(csv(exportRows(source(q), q)));
  });
  app.get("/api/sellers/:id", (req, res) => {
    const q = querySchema.parse(req.query);
    const id = z.string().max(100).parse(req.params.id);
    res.json(sellerDetail(source(q), q, id));
  });
  app.get("/api/offers/:id/history", (req, res) => {
    const q = querySchema.parse(req.query);
    const database = source(q);
    const from = new Date(`${q.from}T00:00:00+03:00`).toISOString();
    const to = new Date(
      Date.parse(`${q.to}T00:00:00+03:00`) + 86400000,
    ).toISOString();
    res.json(
      database
        .prepare(
          "SELECT s.collected_at,price FROM observations o JOIN snapshots s ON s.id=o.snapshot_id WHERE offer_id=? AND collected_at>=? AND collected_at<? ORDER BY collected_at LIMIT 2000",
        )
        .all(req.params.id, from, to),
    );
  });
  app.post("/api/collect", (req, res) => {
    if (collector.status().running)
      return res.status(409).json({ error: "Сбор уже выполняется" });
    if (!db.prepare("SELECT 1 FROM categories WHERE enabled=1 LIMIT 1").get())
      return res.status(400).json({ error: "Включите хотя бы одну категорию" });
    const last = db.prepare("SELECT MAX(started_at) at FROM runs").get();
    if (last.at && Date.now() - Date.parse(last.at) < 60000)
      return res
        .status(429)
        .json({ error: "Повторный сбор доступен через минуту" });
    collector.collect().catch((e) => console.error(e.message));
    res.status(202).json({ ok: true });
  });
  app.patch("/api/settings", (req, res) => {
    const v = z
      .object({
        intervalMinutes: z.number().int().min(15).max(1440),
        retentionDays: z.number().int().min(7).max(365),
        scheduled: z.boolean(),
      })
      .parse(req.body);
    db.exec("BEGIN");
    try {
      for (const [k, value] of Object.entries(v))
        db.prepare("UPDATE settings SET value=? WHERE key=?").run(
          JSON.stringify(value),
          k,
        );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    collector.plan();
    res.json(v);
  });
  app.patch("/api/categories/:id", (req, res) => {
    const v = z.object({ enabled: z.boolean() }).parse(req.body);
    const r = db
      .prepare("UPDATE categories SET enabled=? WHERE id=?")
      .run(v.enabled ? 1 : 0, req.params.id);
    if (!r.changes)
      return res.status(404).json({ error: "Категория не найдена" });
    res.json({ ok: true });
  });
  app.post("/api/categories", (req, res) => {
    const v = z
      .object({ name: z.string().trim().min(2).max(60), url: z.string().url() })
      .parse(req.body);
    const url = categoryUrl(v.url);
    if (db.prepare("SELECT 1 FROM categories WHERE url=?").get(url))
      return res.status(409).json({ error: "Эта категория уже добавлена" });
    if (db.prepare("SELECT COUNT(*) n FROM categories").get().n >= 20)
      return res.status(400).json({ error: "Максимум 20 категорий" });
    const id = `node-${url.split("/").at(-2)}`;
    db.prepare("INSERT INTO categories VALUES(?,?,?,?,?)").run(
      id,
      v.name,
      url,
      1,
      "#78bdce",
    );
    res.status(201).json({ id });
  });
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*path}", (req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  app.use((err, req, res, next) => {
    console.error(err.message);
    res
      .status(err instanceof z.ZodError ? 400 : 500)
      .json({
        error:
          err instanceof z.ZodError
            ? "Проверьте параметры запроса"
            : err.message,
      });
  });
  if (startSchedule) collector.plan();
  return {
    app,
    db,
    collector,
    close: () => {
      collector.stop();
      if (!collector.status().running) {
        db.close();
        demo?.close();
      }
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve("server/index.mjs")
) {
  const instance = createApp();
  const port = Number(process.env.PORT ?? 3400);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = instance.app.listen(port, host, () =>
    console.log(`Market Lens: http://${host}:${port}`),
  );
  const stop = () => {
    instance.collector.stop();
    server.close(() => {
      instance.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
