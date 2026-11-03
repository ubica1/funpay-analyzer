import test from "node:test";
import assert from "node:assert/strict";
import { playerauctionsAccountAttributes } from "../server/playerauctions-fields.mjs";
import { createDatabase, saveSnapshot } from "../server/db.mjs";
import { analyze, querySchema } from "../server/analytics.mjs";

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
test("PlayerAuctions plus between labelled features is not mistaken for a minimum MMR", () => {
  const a = playerauctionsAccountAttributes(
    "6092 MMR+IMMORTAL (Expired)+10999 BEHAVIOR+245 Matches - Ranked Ready Smurf",
  );
  assert.equal(a.solommr, "6092");
  assert.equal(a.decency, "10999");
  assert.equal(a.games, "245");
  assert.equal(a.ranked_access, "open");
  const bound = playerauctionsAccountAttributes("6000+ MMR Ranked Ready");
  assert.equal(bound.solommr, undefined);
  assert.equal(bound.solommr_min, "6000");
});
