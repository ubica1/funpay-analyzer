import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseExternalOffers,
  fetchExternalCategory,
} from "../server/external-collector.mjs";
import { platforms } from "../server/platforms.mjs";
const fixture = (id) =>
  readFileSync(new URL(`./fixtures/${id}-cards.html`, import.meta.url), "utf8");

test("rendered Playerok and Eldorado cards preserve original ad links and correct currency", () => {
  const playerok = parseExternalOffers(fixture("playerok"), "playerok");
  assert.equal(playerok.offers.length, 2);
  assert.equal(playerok.offers[0].price, 1190);
  assert.match(
    playerok.offers[0].url,
    /^https:\/\/playerok.com\/products\/ec1501616cd9-/,
  );
  const eldorado = parseExternalOffers(fixture("eldorado"), "eldorado");
  assert.equal(eldorado.offers.length, 2);
  assert.equal(eldorado.offers[0].price, 8);
  assert.match(
    eldorado.offers[0].url,
    /^https:\/\/www.eldorado.gg\/dota-accounts\/oa\/[\w-]+$/,
  );
  assert.equal(eldorado.offers[0].attributes.currency, "USD");
  assert.equal(eldorado.offers[0].seller, "CharlesDoal");
  assert.throws(() =>
    parseExternalOffers(
      fixture("eldorado")
        .replaceAll("$8.00", "TRY411.45")
        .replaceAll("$14.90", "TRY766.32"),
      "eldorado",
    ),
  );
});

test("browser marketplaces collect automatically; static sources fall back to browser if initial HTML is empty", async () => {
  let calls = 0;
  const playerok = platforms.find((p) => p.id === "playerok");
  const result = await fetchExternalCategory(
    { platform: "playerok", url: playerok.url },
    {
      loadHtml: async () => {
        throw new Error("Browser source should skip redundant static request");
      },
      render: async () => {
        calls++;
        return fixture("playerok");
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.offers.length, 2);
  const g2g = platforms.find((p) => p.id === "g2g");
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "3000 MMR", url: g2g.url + "/offer/G123", offers: { "@type": "Offer", price: 20, priceCurrency: "USD" } })}</script>`;
  const fallback = await fetchExternalCategory(
    { platform: "g2g", url: g2g.url },
    { loadHtml: async () => "<html>Loading</html>", render: async () => html },
  );
  assert.equal(fallback.offers[0].url, g2g.url + "/offer/G123");
  assert.ok(platforms.every((p) => p.automatic !== false));
});
