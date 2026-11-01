import test from "node:test";
import assert from "node:assert/strict";
import { g2gRankProperties } from "../server/g2g-fields.mjs";
import { externalAttributes } from "../server/external-fields.mjs";
import { createDatabase, saveSnapshot } from "../server/db.mjs";
import { analyze, querySchema, exportRows } from "../server/analytics.mjs";
const metadata = `<script>data={offers:[{offer_id:"G1",offer_attributes:[{collection_id:"rank",dataset_id:"ready"}],title:"TBD"},{offer_id:"G2",offer_attributes:[{collection_id:"rank",dataset_id:"unknown"}]}], filters:[{dataset_id:"ready",parent_id:"rank",value:"Rank Ready"},{dataset_id:"unknown",parent_id:"rank",value:"UnRanked"}]};</script>`;
test("G2G structured Rank Ready keeps TBD accounts in the existing open ranked filter", () => {
  const fields = g2gRankProperties(metadata);
  assert.equal(fields.size, 1);
  assert.equal(fields.has("G2"), false);
  const a = externalAttributes("TBD (OLD 2500-3500 MMR)", fields.get("G1"));
  assert.equal(a.type, "под калибровку (tbd)");
  assert.equal(a.ranked_access, "open");
  assert.equal(a.ranked_access_source, "G2G: Rank Ready");
  assert.equal(
    externalAttributes("Not Ranked Ready", fields.get("G1")).ranked_access,
    "closed",
  );
  const db = createDatabase();
  try {
    const at = "2026-11-01T12:00:00.000Z";
    const offer = (id, attributes) => ({
      id,
      title: "TBD",
      price: 8.5,
      seller: "Seller",
      sellerId: id,
      reviews: 0,
      online: true,
      attributes: { ...attributes, platform: "g2g" },
      url: `https://www.g2g.com/offer/${id}`,
    });
    saveSnapshot(
      db,
      "g2g-accounts",
      [offer("G1", a), offer("G2", externalAttributes("TBD"))],
      {},
      at,
    );
    const q = querySchema.parse({
      market: "g2g",
      category: "accounts",
      from: "2026-11-01",
      to: "2026-11-01",
      accountType: "ranked",
    });
    assert.equal(analyze(db, q).stats.count, 1);
    assert.equal(analyze(db, q).offers[0].offer_id, "G1");
    assert.equal(exportRows(db, q).length, 1);
  } finally {
    db.close();
  }
});
test("G2G metadata never executes scripts or treats an unrelated attribute as access", () => {
  assert.equal(
    g2gRankProperties(
      '<script>throw new Error("bad");offer_id:"G1",offer_attributes:[{dataset_id:"unknown"}]</script>',
    ).size,
    0,
  );
});
