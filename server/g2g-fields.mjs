// Read only JSON string literals and attribute pairs from G2G's SSR data.
// Never execute the page's JavaScript.
const string = '"(?:[^"\\\\]|\\\\.)*"';
export function g2gRankProperties(html) {
  const datasets = new Map();
  const definition = new RegExp(
    `dataset_id:(${string}),parent_id:(${string}),value:(${string})`,
    "g",
  );
  for (const m of html.matchAll(definition)) {
    try {
      const label = JSON.parse(m[3]);
      if (
        /^(?:Rank Ready|UnRanked|Herald|Guardian|Crusader|Archon|Legend|Ancient|Divine|Immortal)$/i.test(
          label,
        )
      )
        datasets.set(JSON.parse(m[1]), label);
    } catch {
      /* Ignore unrelated or malformed metadata. */
    }
  }
  const offers = new Map();
  const pattern = new RegExp(
    `offer_id:(${string}),[\\s\\S]*?offer_attributes:\\[([^\\]]*)\\]`,
    "g",
  );
  for (const m of html.matchAll(pattern)) {
    try {
      const labels = [
        ...m[2].matchAll(new RegExp(`dataset_id:(${string})`, "g")),
      ]
        .map((value) => datasets.get(JSON.parse(value[1])))
        .filter(Boolean);
      if (labels.length !== 1) continue;
      const label = labels[0];
      // UnRanked by itself does not prove whether ranked access is unlocked.
      if (/^UnRanked$/i.test(label)) continue;
      offers.set(JSON.parse(m[1]), [
        { name: "ranked access", value: "yes" },
        { name: "G2G Rank", value: label },
      ]);
    } catch {
      /* Unknown access remains unknown. */
    }
  }
  return offers;
}
