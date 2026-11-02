import { platforms, marketIds, selectedCategoryIds } from "./platforms.mjs";
import express from "express";
import { z } from "zod";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createDatabase, seedDemo, settings, saveSnapshot } from "./db.mjs";
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
  app.use(express.json({ limit: "5mb" }));
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
      platforms,
      categories: db
        .prepare(
          "SELECT c.*, (SELECT MAX(collected_at) FROM snapshots WHERE category_id=c.id) lastCollected, r.status lastStatus, r.message lastMessage, r.started_at lastAttemptAt FROM categories c LEFT JOIN runs r ON r.id=(SELECT MAX(id) FROM runs WHERE category_id=c.id)",
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
      .attachment(`marketlens-${q.market}-${q.source}-${q.from}-${q.to}.csv`)
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
  app.post("/api/import", (req, res) => {
    const input = z
      .object({
        platform: z.enum(
          platforms.filter((p) => p.id !== "funpay").map((p) => p.id),
        ),
        currency: z.enum(["RUB", "USD"]),
        offers: z
          .array(
            z.object({
              url: z.string().url().max(2000),
              title: z.string().trim().min(1).max(2000),
              price: z.number().finite().min(0).max(1e9),
              seller: z.string().trim().min(1).max(200),
              sellerId: z.string().min(1).max(300),
              reviews: z.number().int().min(0).max(1e9).default(0),
              online: z.boolean().default(false),
              attributes: z
                .record(z.string().max(100), z.string().max(300))
                .default({}),
            }),
          )
          .min(1)
          .max(10000),
      })
      .parse(req.body);
    const platform = platforms.find((p) => p.id === input.platform);
    if (input.currency !== platform.currency)
      return res.status(400).json({
        error: `Нужны цены в ${platform.currency}; автоматической конвертации нет`,
      });
    const offers = input.offers.map((o) => {
      const url = new URL(o.url);
      if (
        url.protocol !== "https:" ||
        url.hostname !== new URL(platform.url).hostname ||
        url.username ||
        url.password ||
        url.port
      )
        throw new z.ZodError([
          {
            code: "custom",
            path: ["offers"],
            message: "Неверный адрес объявления",
          },
        ]);
      const paId =
        platform.id === "playerauctions"
          ? url.pathname.match(/^\/dota-2-account\/(\d+)a!/)?.[1]
          : null;
      if (platform.id === "playerauctions" && !paId)
        throw new z.ZodError([
          {
            code: "custom",
            path: ["offers"],
            message: "Нужна ссылка на аккаунт Dota 2",
          },
        ]);
      return {
        ...o,
        id: paId
          ? `playerauctions:${paId}`
          : `${platform.id}:${url.pathname.replace(/\/$/, "")}${url.search}`,
        sellerId: `${platform.id}:${o.sellerId}`,
        attributes: {
          ...o.attributes,
          currency: input.currency,
          platform: platform.id,
        },
      };
    });
    const snapshotId = saveSnapshot(db, `${platform.id}-accounts`, offers);
    db.prepare(
      "INSERT INTO runs(started_at,category_id,status,message,count) VALUES(?,?,?,?,?)",
    ).run(
      new Date().toISOString(),
      `${platform.id}-accounts`,
      "success",
      "Импортирован снимок аккаунтов Dota 2",
      new Set(offers.map((o) => o.id)).size,
    );
    res
      .status(201)
      .json({ snapshotId, count: new Set(offers.map((o) => o.id)).size });
  });
  app.post("/api/collect", (req, res) => {
    if (collector.status().running)
      return res.status(409).json({ error: "Сбор уже выполняется" });
    const scope = z
      .object({
        market: z.enum(marketIds).optional(),
        category: z.string().max(500).default("all"),
      })
      .parse(req.body ?? {});
    const selected = scope.market
      ? selectedCategoryIds(db, scope)
      : db
          .prepare("SELECT id FROM categories")
          .all()
          .map((c) => c.id);
    const cats = db
      .prepare("SELECT * FROM categories WHERE enabled=1")
      .all()
      .filter(
        (c) =>
          selected.includes(c.id) &&
          platforms.some((p) => p.id === c.platform && p.automatic !== false),
      );
    if (!cats.length)
      return res.status(400).json({
        error:
          "Для выбранной площадки и категории нет включённого автосбора. Проверьте настройки; для неподключённых площадок доступен импорт.",
      });
    const ids = cats.map((c) => c.id);
    const last = db
      .prepare(
        `SELECT MAX(started_at) at FROM runs WHERE category_id IN (${ids.map(() => "?").join(",")})`,
      )
      .get(...ids);
    if (last.at && Date.now() - Date.parse(last.at) < 60000)
      return res
        .status(429)
        .json({ error: "Повторный сбор этой площадки доступен через минуту" });
    collector.collect(scope).catch((e) => console.error(e.message));
    res
      .status(202)
      .json({ ok: true, collectionId: collector.status().lastCollection?.id });
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
    db.prepare(
      "INSERT INTO categories(id,name,url,enabled,color) VALUES(?,?,?,?,?)",
    ).run(id, v.name, url, 1, "#78bdce");
    db.prepare("UPDATE categories SET kind=? WHERE id=?").run(id, id);
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
    res.status(err instanceof z.ZodError ? 400 : 500).json({
      error:
        err instanceof z.ZodError ? "Проверьте параметры запроса" : err.message,
    });
  });
  if (startSchedule) collector.plan();
  return {
    app,
    db,
    collector,
    close: () => {
      collector.stop();
      if (!collector.status().running && !collector.status().verifying) {
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
