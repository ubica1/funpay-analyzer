import test from "node:test";
import assert from "node:assert/strict";
import {
  collectPlayerauctionsPages,
  playerauctionsPageInfo,
  playerauctionsDescriptionEvidence,
  playerauctionsCatalog,
} from "../server/playerauctions-browser.mjs";
import {
  parseExternalOffers,
  fetchExternalCategory,
} from "../server/external-collector.mjs";
import { createDatabase } from "../server/db.mjs";
import { platforms } from "../server/platforms.mjs";
const html = (ids, total, next) =>
  `<div class="offer-search-count"><span class="count">${total}</span> Offers found</div>${ids.map((id) => `<div class="offer-item"><div class="offer-title"><a href="/dota-2-account/${id}a!original-title/">Ranked Ready ${id} MMR</a></div><div class="offer-seller-name"><a href="/store/seller/">Seller</a></div><div class="offer-price-tag price">$ 12.50</div><div class="offer-delivery"><span class="OLP-delivery-text">Instant</span></div><a href="/dota-2-account/${id}a!original-title/" title="BUY NOW">BUY NOW</a></div>`).join("")}<ul class="pagination"><li><a aria-label="Next Page" href="${playerauctionsCatalog}?PageIndex=${next}">Next</a></li></ul>`;
const parsePage = (h) => parseExternalOffers(h, "playerauctions");
test("browser collection follows every page of the full Dota 2 account category, not the Immortal search", async () => {
  const urls = [];
  const r = await collectPlayerauctionsPages({
    parsePage,
    loadPage: async (url) => {
      urls.push(url);
      return urls.length === 1 ? html([100, 101], 3, 2) : html([102], 3, 2);
    },
  });
  assert.equal(r.offers.length, 3);
  assert.equal(r.advertised, 3);
  assert.equal(r.pages, 2);
  assert.equal(urls[0], playerauctionsCatalog);
  assert.equal(urls[1], playerauctionsCatalog + "?PageIndex=2");
  assert.match(r.offers[2].url, /102a!original-title/);
  assert.equal(r.offers[2].price, 12.5);
});
test("missing, repeated, changed-count and foreign pages never produce a partial success", async () => {
  await assert.rejects(
    () =>
      collectPlayerauctionsPages({
        parsePage,
        loadPage: async () => html([100], 3, 1),
      }),
    /собрано 1 из 3/,
  );
  await assert.rejects(
    () =>
      collectPlayerauctionsPages({
        parsePage,
        loadPage: async () => html([100], 3, 2),
      }),
    /повторяет предыдущую/,
  );
  let i = 0;
  await assert.rejects(
    () =>
      collectPlayerauctionsPages({
        parsePage,
        loadPage: async () =>
          ++i === 1 ? html([100], 2, 2) : html([101], 3, 2),
      }),
    /изменился/,
  );
  assert.throws(
    () =>
      playerauctionsPageInfo(
        html([100], 2, 2).replace(
          'href="' + playerauctionsCatalog + '?PageIndex=2"',
          'href="https://evil.example/?PageIndex=2"',
        ),
        playerauctionsCatalog,
      ),
    /неверный адрес/,
  );
});
test("public description labels are read as facts; failed description requests do not drop collected listings", async () => {
  const description =
    '<div id="offer-description-section"><div class="description-content"><div><span>MMR</span><span>5 802</span></div><div><span>RANK</span><span>Immortal</span></div></div></div>';
  assert.match(
    playerauctionsDescriptionEvidence(description),
    /RANK: Immortal/,
  );
  const r = await collectPlayerauctionsPages({
    parsePage,
    loadPage: async () => html([100, 101], 2, 1),
    readDescription: async (url) => {
      if (url.includes("101a!")) throw new Error("Temporary failure");
      return description;
    },
  });
  assert.equal(r.offers.length, 2);
  assert.equal(r.detailsFailed, 1);
  assert.equal(r.offers[0].attributes.solommr, "5802");
  assert.equal(r.offers[0].attributes.ranked_access, "open");
});
test("PlayerAuctions defaults to browser collection without any API keys and migrates the category URL", async () => {
  const p = platforms.find((p) => p.id === "playerauctions");
  assert.equal(p.url, playerauctionsCatalog);
  let called = false;
  await fetchExternalCategory(
    { platform: p.id, url: p.url },
    {
      playerauctions: async ({ parsePage }) => {
        called = true;
        return parsePage(html([100], 1, 1));
      },
      loadHtml: () => {
        throw new Error("No static/API collection");
      },
    },
  );
  assert.equal(called, true);
  const db = createDatabase();
  try {
    assert.equal(
      db
        .prepare("SELECT url FROM categories WHERE platform='playerauctions'")
        .get().url,
      playerauctionsCatalog,
    );
  } finally {
    db.close();
  }
});

test("Calibrated is explicit access; Uncalibrated and not calibrated stay unknown", async () => {
  const { playerauctionsAccountAttributes: a } = await import(
    "../server/playerauctions-fields.mjs"
  );
  assert.equal(a("Calibrated 1970 MMR").ranked_access, "open");
  assert.equal(a("Uncalibrated 1970 MMR").ranked_access, "unknown");
  assert.equal(a("Not calibrated 1970 MMR").ranked_access, "unknown");
  assert.equal(a("Calibrated 1970 MMR Ranked Locked").ranked_access, "closed");
});
