export type AccountFilters = {
  saleType: "all" | "sale" | "rent";
  accountType: "all" | "ranked" | "calibration" | "unranked";
  auto: "all" | "1";
  mmrMin: string;
  mmrMax: string;
  decencyMin: string;
  decencyMax: string;
  politenessMin: string;
  politenessMax: string;
  gamesMin: string;
  gamesMax: string;
  hoursMin: string;
  hoursMax: string;
};
export const accountFilterDefaults: AccountFilters = {
  saleType: "all",
  accountType: "all",
  auto: "all",
  mmrMin: "",
  mmrMax: "",
  decencyMin: "",
  decencyMax: "",
  politenessMin: "",
  politenessMax: "",
  gamesMin: "",
  gamesMax: "",
  hoursMin: "",
  hoursMax: "",
};
export const accountRanges = [
  { key: "mmr", label: "MMR" },
  { key: "decency", label: "Порядочность" },
  { key: "politeness", label: "Вежливость" },
  { key: "games", label: "Матчей" },
  { key: "hours", label: "Часов" },
] as const;
const labels: Record<string, string> = {
  type1: "Сделка",
  type: "Тип аккаунта",
  solommr: "MMR",
  mmr: "MMR",
  decency: "Порядочность",
  politeness: "Вежливость",
  games: "Матчей",
  time: "Часов",
  auto: "Автовыдача",
  region: "Регион",
};
export const attributeLabel = (key: string) => labels[key] ?? key;
export function numericMmr(attributes: Record<string, string>) {
  const value = attributes.solommr?.replace(/\s/g, "").replace(",", ".");
  return value && /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 1e9
    ? Number(value)
    : null;
}
export function attributeDisplay(key: string, value: string) {
  if (key === "auto") return value === "1" ? "Да" : "Нет";
  if (key === "type1" || key === "type")
    return value.charAt(0).toLocaleUpperCase("ru-RU") + value.slice(1);
  if (
    ["solommr", "decency", "politeness", "games", "time"].includes(key) &&
    /^\d+(?:\.\d+)?$/.test(value)
  )
    return Number(value).toLocaleString("ru-RU");
  return value;
}
export function offerTags(attributes: Record<string, string>) {
  const priority = [
    "type1",
    "type",
    "solommr",
    "region",
    "mmr",
    "decency",
    "games",
    "time",
  ];
  const keys = [
    ...priority,
    ...Object.keys(attributes).filter(
      (k) => !priority.includes(k) && k !== "auto",
    ),
  ];
  return keys
    .filter((k) => attributes[k] !== undefined)
    .slice(0, 3)
    .map((key) => ({
      key,
      text:
        key === "solommr"
          ? `${attributeDisplay(key, attributes[key])} MMR`
          : attributeDisplay(key, attributes[key]),
    }));
}
