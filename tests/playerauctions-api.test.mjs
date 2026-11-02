import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPlayerauctionsAccounts,
  playerauctionsAccountAttributes,
  playerauctionsHeaders,
  playerauctionsRequest,
} from "../server/playerauctions-api.mjs";
import { createDatabase, saveSnapshot } from "../server/db.mjs";
import { analyze, querySchema } from "../server/analytics.mjs";

test("official marketplace API selects Dota 2 accounts, follows pages, uses USD and stable offer IDs", async () => {
  const calls = [];
  const result = await fetchPlayerauctionsAccounts({
    requestData: async (path) => {
      calls.push(path);
      if (path === "/api/v1/games")
        return {
          data: [
            { gameId: 999, gameName: "Other Game" },
            { gameId: 123, gameName: "DOTA 2" },
          ],
        };
      const q = new URL(path, "https://seller-api.playerauctions.com")
        .searchParams;
      assert.equal(q.get("gameId"), "123");
      assert.equal(q.get("pageSize"), "100");
      return {
        data: {
          count: 2,
          items: [
            {
              offerId: Number(q.get("pageIndex")),
              offerTitleUrl: `https://www.playerauctions.com/dota-2-account/${q.get("pageIndex")}a!actual-canonical-title/`,
              offerTitle:
                q.get("pageIndex") === "1"
                  ? "Immortal Ranked Ready 6000 MMR"
                  : "Herald account",
              price: 12.5,
              sellerName: "Seller",
              deliveryTime: "Instant",
            },
          ],
        },
      };
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].id, "playerauctions:1");
  assert.equal(result.offers[0].attributes.currency, "USD");
  assert.equal(result.offers[0].attributes.ranked_access, "open");
  assert.equal(result.offers[0].reviews, 0);
  assert.equal(result.advertised, 1);
});
test("current rank in description establishes access; expired medal and unknown title do not", () => {
  const attrs = playerauctionsAccountAttributes(
    "Immortal 5802MMR Mainpool | 10797 Behavior",
    "MMR: 5 802\nRANK: Immortal",
    true,
  );
  assert.equal(attrs.ranked_access, "open");
  assert.equal(attrs.solommr, "5802");
  assert.equal(attrs.auto, "1");
  assert.equal(
    playerauctionsAccountAttributes("Ranked Locked", "RANK: Immortal")
      .ranked_access,
    "closed",
  );
  assert.equal(
    playerauctionsAccountAttributes(
      "Immortal item collection",
      "RANK: Immortal (Expired)",
    ).ranked_access,
    "unknown",
  );
  const db = createDatabase();
  try {
    saveSnapshot(db, "playerauctions-accounts", [
      {
        id: "pa:1",
        title: "Account",
        price: 98,
        seller: "Seller",
        sellerId: "S",
        reviews: 1886,
        online: false,
        attributes: attrs,
        url: "https://www.playerauctions.com/dota-2-account/123a!account/",
      },
    ]);
    const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
    assert.equal(
      analyze(
        db,
        querySchema.parse({
          market: "playerauctions",
          from: today,
          to: today,
          saleType: "sale",
          accountType: "ranked",
          mmrMin: 5400,
        }),
      ).stats.count,
      1,
    );
  } finally {
    db.close();
  }
});
test("missing API keys fail before network requests; credentials never appear in errors", async () => {
  await assert.rejects(
    () => playerauctionsRequest("/api/v1/games", { key: "", secret: "" }),
    /API-ключ/,
  );
  const h = playerauctionsHeaders(
    "example-key",
    "example-secret",
    1700000000000,
  );
  assert.equal(h["X-PA-TIMESTAMP"], "1700000000");
  assert.match(h["X-PA-SIGN"], /^[0-9a-f]{64}$/);
  assert.equal(h["X-PA-API-KEY"], "example-key");
  await assert.rejects(
    () =>
      fetchPlayerauctionsAccounts({
        requestData: async (path) =>
          path === "/api/v1/games"
            ? { data: [{ gameId: 123, gameName: "DOTA 2" }] }
            : { data: { count: 10, items: [] } },
      }),
    /все страницы/,
  );
});
