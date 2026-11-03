import { externalAttributes } from "./external-fields.mjs";
export function normalizePlayerauctionsTitle(title) {
  // Sellers join labelled fields using '+': '6092 MMR+Immortal' is an
  // exact MMR followed by another feature, unlike '6092+ MMR'.
  return title.replace(
    /(\d\s*(?:MMR|behavior|behaviour|matches|hours))\s*\+(?=\s*[a-z\d])/gi,
    "$1 | ",
  );
}
export function playerauctionsDescriptionProperties(evidence = "") {
  const result = [];
  for (const [name, value] of [
    ...evidence.matchAll(
      /^(MMR|BEHAVIOR(?: SCORE)?|BEHAVIOUR(?: SCORE)?|DECENCY|COMMUNICATION SCORE):\s*([\d ,]+)\s*$/gim,
    ),
  ].map((m) => [m[1], m[2]])) {
    result.push({
      name: /^DECENCY$/i.test(name) ? "behavior" : name,
      value: value.replace(/[ ,]/g, ""),
    });
  }
  const ranks = [
    ...evidence.matchAll(
      /^RANK:\s*(Immortal|Divine|Ancient|Legend|Archon|Crusader|Guardian|Herald)(?:\s+[IVX\d]+)?\s*$/gim,
    ),
  ];
  if (ranks.length) result.push({ name: "Ranked access", value: true });
  return result;
}
export function playerauctionsAccountAttributes(
  title,
  evidence = "",
  instant,
  properties = [],
) {
  const props = [
    ...[properties].flat().filter(Boolean),
    ...playerauctionsDescriptionProperties(evidence),
  ];
  const calibrated =
    /\bcalibrated\b/i.test(title) &&
    !/\b(?:not|never|non)[ -]+calibrated\b/i.test(title);
  if (calibrated) props.unshift({ name: "Ranked access", value: true });
  const attributes = {
    type1: "продажа",
    ...externalAttributes(
      normalizePlayerauctionsTitle(title) + (evidence ? "\n" + evidence : ""),
      props,
    ),
    platform: "playerauctions",
    currency: "USD",
  };
  if (props.some((p) => p.name === "Ranked access"))
    attributes.ranked_access_source =
      evidence && /^RANK:/im.test(evidence)
        ? "Описание PlayerAuctions: текущий ранг"
        : "Заголовок PlayerAuctions: Calibrated";
  if (evidence && props.some((p) => p.name !== "Ranked access"))
    attributes.parameter_source = "Описание объявления PlayerAuctions";
  if (typeof instant === "boolean") attributes.auto = instant ? "1" : "0";
  return attributes;
}
