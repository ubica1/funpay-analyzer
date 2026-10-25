import { X, SlidersHorizontal, RotateCcw, Info } from "lucide-react";
import type { Filters } from "./types";
import { accountFilterDefaults, accountRanges } from "./account-fields";

type Props = {
  filters: Filters;
  onChange: (values: Partial<Filters>) => void;
  expanded: boolean;
};
export function AccountFilters({ filters, onChange, expanded }: Props) {
  const chips: { label: string; reset: Partial<Filters> }[] = [];
  if (filters.saleType !== "all")
    chips.push({
      label: filters.saleType === "sale" ? "Продажа" : "Аренда",
      reset: {
        saleType: "all",
        accountType: "all",
        hoursMin: "",
        hoursMax: "",
      },
    });
  if (filters.accountType !== "all")
    chips.push({
      label: {
        ranked: "С рейтингом",
        calibration: "Под калибровку (TBD)",
        unranked: "Без рейтингового доступа",
      }[filters.accountType],
      reset: { accountType: "all", hoursMin: "", hoursMax: "" },
    });
  for (const { key, label } of accountRanges) {
    const min = filters[`${key}Min`],
      max = filters[`${key}Max`];
    if (min || max)
      chips.push({
        label: `${label}: ${min || "0"} — ${max || "∞"}`,
        reset: { [`${key}Min`]: "", [`${key}Max`]: "" },
      });
  }
  if (filters.auto === "1")
    chips.push({ label: "Автовыдача", reset: { auto: "all" } });
  return (
    <div className="account-filters">
      <div className="account-filter-heading">
        <span>
          <SlidersHorizontal size={14} /> Параметры аккаунтов
        </span>
        {chips.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => onChange(accountFilterDefaults)}
          >
            <RotateCcw size={12} /> Сбросить параметры
          </button>
        )}
      </div>
      <div className="account-primary-filters">
        <div className="deal-type">
          <span className="field-caption">Тип сделки</span>
          <div
            className="deal-type-buttons"
            role="group"
            aria-label="Тип сделки"
          >
            {(
              [
                ["all", "Все"],
                ["sale", "Продажа"],
                ["rent", "Аренда"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filters.saleType === value}
                className={filters.saleType === value ? "selected" : ""}
                onClick={() =>
                  onChange({
                    saleType: value,
                    ...(value !== "sale"
                      ? {
                          accountType: "all" as const,
                          hoursMin: "",
                          hoursMax: "",
                        }
                      : {}),
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <RangeField
          name="mmr"
          label="MMR"
          filters={filters}
          onChange={onChange}
        />
        {filters.saleType === "sale" && (
          <label className="account-type">
            <span className="field-caption">Тип аккаунта</span>
            <select
              value={filters.accountType}
              onChange={(e) =>
                onChange({
                  accountType: e.target.value as Filters["accountType"],
                  ...(e.target.value !== "ranked"
                    ? { hoursMin: "", hoursMax: "" }
                    : {}),
                })
              }
            >
              <option value="all">Все типы аккаунтов</option>
              <option value="ranked">С рейтингом</option>
              <option value="calibration">Под калибровку (TBD)</option>
              <option value="unranked">Без доступа к рейтинговым играм</option>
            </select>
          </label>
        )}
        <label className="auto-delivery">
          <input
            type="checkbox"
            checked={filters.auto === "1"}
            onChange={(e) => onChange({ auto: e.target.checked ? "1" : "all" })}
          />{" "}
          Автовыдача{" "}
          <Info size={12}>
            <title>
              Автовыдача фиксируется в новых снимках после обновления сборщика
            </title>
          </Info>
        </label>
      </div>
      {expanded && (
        <div className="account-extra-filters">
          {accountRanges
            .filter(
              (f) =>
                f.key !== "mmr" &&
                (f.key !== "hours" ||
                  (filters.saleType === "sale" &&
                    filters.accountType === "ranked")),
            )
            .map(({ key, label }) => (
              <RangeField
                key={key}
                name={key}
                label={label}
                filters={filters}
                onChange={onChange}
              />
            ))}
        </div>
      )}
      {chips.length > 0 && (
        <div
          className="active-account-filters"
          aria-label="Активные параметры аккаунтов"
        >
          {chips.map(({ label, reset }) => (
            <button
              type="button"
              key={label}
              onClick={() => onChange(reset)}
              aria-label={`Сбросить фильтр ${label}`}
            >
              {label}
              <X size={12} />
            </button>
          ))}
        </div>
      )}
      {filters.auto === "1" && (
        <p className="account-filter-hint">
          <Info size={12} /> Автовыдача доступна в снимках, собранных после
          обновления. Для старой истории этот признак неизвестен.
        </p>
      )}
    </div>
  );
}
function RangeField({
  name,
  label,
  filters,
  onChange,
}: {
  name: (typeof accountRanges)[number]["key"];
  label: string;
  filters: Filters;
  onChange: Props["onChange"];
}) {
  return (
    <div className="account-range">
      <span className="field-caption">{label}</span>
      <div className="account-range-inputs">
        <input
          type="number"
          min="0"
          step="1"
          aria-label={`${label} от`}
          placeholder="от"
          value={filters[`${name}Min`]}
          onChange={(e) => onChange({ [`${name}Min`]: e.target.value })}
        />
        <span>—</span>
        <input
          type="number"
          min="0"
          step="1"
          aria-label={`${label} до`}
          placeholder="до"
          value={filters[`${name}Max`]}
          onChange={(e) => onChange({ [`${name}Max`]: e.target.value })}
        />
      </div>
    </div>
  );
}
