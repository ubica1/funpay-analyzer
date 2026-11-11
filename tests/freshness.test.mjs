import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, saveSnapshot } from "../server/db.mjs";
import { analyze, querySchema } from "../server/analytics.mjs";
import { createCollector } from "../server/collector.mjs";
import {
  fetchListing,
  collectionError,
  retrySnapshot,
  upstreamError,
} from "../server/http.mjs";
const offer = {
  id: "1",
  title: "Account",
  price: 100,
  seller: "Seller",
  sellerId: "1",
  reviews: 1,
  online: true,
  attributes: {},
  url: "https://funpay.com/lots/offer?id=1",
};
const query = (extra) =>
  querySchema.parse({
    market: "funpay",
    category: "accounts",
    from: "2026-10-01",
    to: "2026-11-01",
    ...extra,
  });

test("failed collection keeps the previous snapshot date and exposes the error despite later system success logs", () => {
  const db = createDatabase();
  try {
    const old = "2026-10-27T01:57:11.919Z";
    saveSnapshot(db, "accounts", [offer], {}, old);
    const run = db.prepare(
      "INSERT INTO runs(started_at,category_id,status,message) VALUES(?,?,?,?)",
    );
    run.run(
      "2026-11-01T18:55:17.937Z",
      "accounts",
      "error",
      "Connection failed",
    );
    run.run(
      "2026-11-01T18:55:53.950Z",
      null,
      "success",
      "Background verification",
    );
    const result = analyze(db, query());
    assert.equal(result.stats.count, 1);
    assert.equal(result.offers[0].collected_at, old);
    assert.equal(result.freshness[0].displayedAt, old);
    assert.equal(result.freshness[0].lastAttempt.message, "Connection failed");
    assert.equal(result.freshness[0].failed, true);
    const now = "2026-11-01T19:00:00.000Z";
    saveSnapshot(db, "accounts", [offer], {}, now);
    run.run(now, "accounts", "success", "Snapshot saved");
    const updated = analyze(db, query());
    assert.equal(updated.freshness[0].failed, false);
    assert.equal(updated.freshness[0].displayedAt, now);
    const historical = analyze(db, query({ to: "2026-10-31" }));
    assert.equal(historical.freshness[0].displayedAt, old);
    assert.equal(historical.freshness[0].latestSnapshotAt, now);
  } finally {
    db.close();
  }
});

test("collection completion reports a failed fetch rather than success and does not start sale verification", async () => {
  const db = createDatabase();
  let verified = false;
  const collector = createCollector(db, {
    fetchPublic: async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("DNS unavailable"), {
          code: "EAI_AGAIN",
        }),
      });
    },
    verify: async () => {
      verified = true;
      return { checked: 0, left: 0 };
    },
    pauseMs: 0,
  });
  try {
    await collector.collect({ market: "funpay", category: "accounts" });
    const result = collector.status().lastCollection;
    assert.ok(result.finishedAt);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, "error");
    assert.match(result.results[0].message, /EAI_AGAIN/);
    assert.equal(verified, false);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, 0);
  } finally {
    collector.stop();
    await collector.settled();
    db.close();
  }
});

test("only transient connection errors retry once with the same deadline; TLS and HTTP refusals are not retried", async () => {
  let calls = 0;
  const signals = [];
  const result = await fetchListing(
    "https://funpay.com/",
    {},
    {
      fetchImpl: async (url, opts) => {
        signals.push(opts.signal);
        if (++calls === 1)
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
          });
        return { status: 200 };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);
  calls = 0;
  await assert.rejects(() =>
    fetchListing(
      "https://funpay.com/",
      {},
      {
        fetchImpl: async () => {
          calls++;
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("TLS"), {
              code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            }),
          });
        },
      },
    ),
  );
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(
    (
      await fetchListing(
        "https://funpay.com/",
        {},
        {
          fetchImpl: async () => {
            calls++;
            return { status: 403 };
          },
        },
      )
    ).status,
    403,
  );
  assert.equal(calls, 1);
  assert.match(
    collectionError(
      Object.assign(new Error("deadline"), { name: "TimeoutError" }),
    ),
    /20 секунд/,
  );
});

test("a temporary upstream failure retries once but a refusal propagates immediately", async () => {
  let calls = 0;
  const wait = async () => {};
  assert.equal(
    await retrySnapshot(
      async () => {
        if (++calls === 1) throw upstreamError("Playerok", 503);
        return "complete";
      },
      { wait },
    ),
    "complete",
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    retrySnapshot(
      async () => {
        calls++;
        throw upstreamError("Playerok", 403);
      },
      { wait },
    ),
    /403/,
  );
  assert.equal(calls, 1);
});
