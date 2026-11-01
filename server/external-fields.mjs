// Only unambiguous, explicitly labelled values are usable as exact filters.
// Intervals, minimums (3000+), and multiple conflicting values stay unknown.
const numberToken = "(\\d+(?:[.,]\\d+)?[kк]|\\d{1,3}(?:[ ,]\\d{3})+|\\d{1,7})";
const definitions = {
  solommr: ["MMR", "ММР", "рейтинг"],
  decency: ["behavior(?: score)?", "behaviour(?: score)?", "порядочность"],
  politeness: ["communication(?: score)?", "вежливость"],
  games: ["matches", "games", "матч(?:ей|и|а)", "игр"],
  time: ["hours", "hrs", "час(?:ов|а)?"],
};
export function externalAttributes(title = "", properties = []) {
  const text = title
    .normalize("NFKC")
    .replace(/[\u200b-\u200d]/g, "")
    .replace(/[–—]/g, "-");
  const attributes = {};
  const sources = [];
  for (const [field, labels] of Object.entries(definitions)) {
    const label = `(?:${labels.join("|")})`;
    const values = [];
    // Reject a range next to either end of a labelled number.
    for (const [direction, pattern] of [
      new RegExp(`${label}\\s*[:=-]?\\s*${numberToken}`, "gi"),
      new RegExp(`${numberToken}\\s*${label}`, "gi"),
    ].entries()) {
      for (const match of text.matchAll(pattern)) {
        const before = text.slice(0, match.index),
          after = text.slice(match.index + match[0].length);
        if (
          /\d\s*[-+]\s*$/.test(before) ||
          /^\s*(?:\+|[-/]\s*\d|[.,]\d|[kк])/.test(after)
        )
          continue;
        // In "MMR 5000 Behavior 12000", 5000 belongs to MMR;
        // the Behavior label has its own value on the right.
        if (direction === 1 && /^\s*[:=-]?\s*\d/.test(after)) continue;
        const raw = match[1];
        const value = /[kк]$/i.test(raw)
          ? Number(raw.slice(0, -1).replace(",", ".")) * 1000
          : Number(raw.replace(/[ ,]/g, ""));
        if (Number.isFinite(value) && value <= 1e9) values.push(value);
      }
    }
    const boundPairs = [];
    for (const pattern of [
      new RegExp(
        `${label}\\s*[:=]?\\s*${numberToken}\\s*-\\s*${numberToken}`,
        "gi",
      ),
      new RegExp(`${numberToken}\\s*-\\s*${numberToken}\\s*${label}`, "gi"),
    ]) {
      for (const m of text.matchAll(pattern)) boundPairs.push([m[1], m[2]]);
    }
    const parseBound = (raw) =>
      /[kк]$/i.test(raw)
        ? Number(raw.slice(0, -1).replace(",", ".")) * 1000
        : Number(raw.replace(/[ ,]/g, ""));
    for (const pattern of [
      new RegExp(`${label}\\s*[:=]?\\s*${numberToken}\\s*\\+`, "gi"),
      new RegExp(`${numberToken}\\s*\\+\\s*${label}`, "gi"),
    ]) {
      for (const m of text.matchAll(pattern)) boundPairs.push([m[1], null]);
    }
    const bounds = [
      ...new Map(
        boundPairs.map(([lo, hi]) => {
          const pair = [parseBound(lo), hi == null ? null : parseBound(hi)];
          return [JSON.stringify(pair), pair];
        }),
      ).values(),
    ];
    if (
      bounds.length === 1 &&
      Number.isFinite(bounds[0][0]) &&
      bounds[0][0] <= 1e9 &&
      (bounds[0][1] == null || bounds[0][1] >= bounds[0][0])
    ) {
      attributes[`${field}_min`] = String(bounds[0][0]);
      if (bounds[0][1] != null)
        attributes[`${field}_max`] = String(bounds[0][1]);
      sources.push(field);
    }
    const unique = [...new Set(values)];
    if (unique.length === 1) {
      attributes[field] = String(unique[0]);
      sources.push(field);
    }
  }
  if (sources.length) attributes.parameter_source = "Заголовок объявления";
  // Structured fields override title text, including zero. No promotional
  // product rating is substituted for a seller's review count.
  for (const prop of [properties].flat().filter(Boolean)) {
    if (typeof prop.name !== "string") continue;
    const name = prop.name.trim().toLowerCase();
    for (const [field, labels] of Object.entries(definitions)) {
      if (
        name === field ||
        labels.some((label) => new RegExp(`^${label}$`, "i").test(name))
      ) {
        const value = String(prop.value ?? "").replace(/\s/g, "");
        if (/^\d+$/.test(value) && Number(value) <= 1e9)
          attributes[field] = value;
      }
    }
  }
  // MMR and medal names do not establish access to ranked matches.
  const closed =
    /(?:not|non)[ -]?(?:ranked|rank)[ -]?ready|rank(?:ed)?[ -]?(?:locked|not ready)|без доступа к рейтинг|закрыт[а-я]*\s+рейтинг[а-я]*|рейтинг[а-я]*\s+закрыт|не\s*открыт[а-я]*\s+рейтинг|до (?:открытия )?рейтинг/i.test(
      text,
    );
  const open =
    /(?:ranked|rank)[ -]?ready|rank(?:ed)?[ -]?(?:unlocked|access)|открыт(?:ый|ые)?\s+рейтинг|рейтинг\s+(?:открыт|доступен)|доступ(?:ен)?\s+к рейтингов/i.test(
      text,
    );
  attributes.ranked_access = closed ? "closed" : open ? "open" : "unknown";
  for (const prop of [properties].flat().filter(Boolean)) {
    if (
      /^(?:ranked access|ranked ready|rank ready|доступен рейтинг|доступ к рейтингу)$/i.test(
        prop.name ?? "",
      )
    ) {
      const value = String(prop.value).trim().toLowerCase();
      if (/^(?:yes|true|1|да|open)$/.test(value))
        attributes.ranked_access = "open";
      if (/^(?:no|false|0|нет|closed)$/.test(value))
        attributes.ranked_access = "closed";
    }
  }
  if (closed) attributes.ranked_access = "closed";
  const g2gRank = [properties].flat().find((p) => p?.name === "G2G Rank");
  if (g2gRank) attributes.ranked_access_source = `G2G: ${g2gRank.value}`;
  if (attributes.ranked_access === "closed")
    attributes.type = "без доступа к рейтинговым играм";
  else if (/\b(?:uncalibrated|tbd)\b|под калибровку/i.test(text))
    attributes.type = "под калибровку (tbd)";
  else if (attributes.ranked_access === "open") attributes.type = "с рейтингом";
  if (/\brent(?:al)?\b|аренда/i.test(text)) attributes.type1 = "аренда";
  if (/instant(?: delivery)?|автовыдача|мгновенная выдача/i.test(text))
    attributes.auto = "1";
  return attributes;
}
export function backfillExternalFields(db) {
  if (
    db
      .prepare("SELECT value FROM settings WHERE key='externalFieldsVersion'")
      .get()?.value === "3"
  )
    return;
  const rows = db
    .prepare(
      "SELECT o.rowid row_id,o.title,o.attributes FROM observations o JOIN snapshots s ON s.id=o.snapshot_id JOIN categories c ON c.id=s.category_id WHERE c.platform!='funpay'",
    )
    .all();
  db.exec("BEGIN");
  try {
    const update = db.prepare(
      "UPDATE observations SET attributes=? WHERE rowid=?",
    );
    for (const row of rows) {
      const parsed = externalAttributes(row.title);
      const stored = JSON.parse(row.attributes);
      // Remove the earlier type inference from MMR; preserve numeric fields.
      delete stored.type;
      update.run(
        JSON.stringify({
          ...parsed,
          ...stored,
          ranked_access: parsed.ranked_access,
        }),
        row.row_id,
      );
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings VALUES('externalFieldsVersion','3')",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
