import { externalAttributes } from "./external-fields.mjs";
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
export function playerauctionsAccountAttributes(title, evidence = "", instant) {
  const props = playerauctionsDescriptionProperties(evidence);
  const attributes = {
    type1: "продажа",
    ...externalAttributes(title + (evidence ? "\n" + evidence : ""), props),
    platform: "playerauctions",
    currency: "USD",
  };
  if (props.some((p) => p.name === "Ranked access"))
    attributes.ranked_access_source = "Описание PlayerAuctions: текущий ранг";
  if (props.some((p) => p.name !== "Ranked access"))
    attributes.parameter_source = "Описание объявления PlayerAuctions";
  if (typeof instant === "boolean") attributes.auto = instant ? "1" : "0";
  return attributes;
}
