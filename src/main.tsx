import { AccountFilters } from "./AccountFilters";
import {
  accountFilterDefaults,
  attributeLabel,
  attributeDisplay,
  numericMmr,
  offerTags,
} from "./account-fields";
import React, { useEffect, useState, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Bell,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Download,
  ExternalLink,
  Filter,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Target,
  Users,
  X,
  Info,
  Trash2,
  CalendarDays,
  ScanLine,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
} from "recharts";
import type { Analytics, Bootstrap, Filters, Offer, Settings } from "./types";
import "./styles.css";

const number = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n);
const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n)} ₽`;
const compact = (n: number) =>
  n >= 1000
    ? `${(n / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}к`
    : number(n);
const dateLabel = (s: string) =>
  new Date(s).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const dateKey = (d: Date) =>
  new Date(d.getTime() + 10800000).toISOString().slice(0, 10);
const today = dateKey(new Date());
const initial: Filters = {
  ...accountFilterDefaults,
  source: "live",
  category: "accounts",
  from: dateKey(new Date(Date.now() - 29 * 86400000)),
  to: today,
  q: "",
  min: "",
  max: "",
  reviews: "",
  online: "all",
  attribute: "",
  value: "",
  sort: "price_asc",
  page: 1,
};
function query(f: Filters) {
  const s = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => {
    if (v !== "") s.set(k, String(v));
  });
  return s.toString();
}
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "MarketLens",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: `Ошибка HTTP ${res.status}` }));
    throw Error(data.error);
  }
  return res.json();
}
const readStore = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [filters, setFilters] = useState<Filters>(initial);
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("overview");
  const [advanced, setAdvanced] = useState(false);
  const [metric, setMetric] = useState<"median" | "minimum" | "count">(
    "median",
  );
  const [toast, setToast] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() =>
    readStore("ml-favorites", []),
  );
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [presets, setPresets] = useState<{ name: string; filters: Filters }[]>(
    () => readStore("ml-presets", []),
  );
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [history, setHistory] = useState<
    { collected_at: string; price: number }[]
  >([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const update = (p: Partial<Filters>) =>
    setFilters((f) => ({ ...f, ...p, page: 1 }));
  const loadBoot = () =>
    api<Bootstrap>("/api/bootstrap").then((b) => {
      setBoot(b);
      return b;
    });
  useEffect(() => {
    loadBoot()
      .then((b) => {
        setFilters((f) => ({ ...f, source: b.hasData ? "live" : "demo" }));
        setReady(true);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);
  const lastRun = useRef<number | undefined>(undefined);
  useEffect(() => {
    const timer = setInterval(
      () =>
        loadBoot()
          .then((b) => {
            if (b.collector.running || lastRun.current !== b.runs[0]?.id)
              setRefresh((n) => n + 1);
            lastRun.current = b.runs[0]?.id;
          })
          .catch(() => {}),
      10000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      api<Analytics>(`/api/analytics?${query(filters)}`, {
        signal: controller.signal,
      })
        .then(setData)
        .catch((e) => {
          if (e.name !== "AbortError") {
            setError(e.message);
            setData(null);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, refresh, ready]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    localStorage.setItem("ml-favorites", JSON.stringify(favorites));
  }, [favorites]);
  useEffect(() => {
    localStorage.setItem("ml-presets", JSON.stringify(presets));
  }, [presets]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOffer(null);
        setSaveOpen(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!offer && !saveOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,a[href],[tabindex="0"]',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [offer, saveOpen]);
  useEffect(() => {
    if (!offer) return;
    let cancelled = false;
    setHistory([]);
    setHistoryError("");
    setHistoryLoading(true);
    api<{ collected_at: string; price: number }[]>(
      `/api/offers/${encodeURIComponent(offer.offer_id)}/history?${query(filters)}`,
    )
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch((e) => {
        if (!cancelled) setHistoryError(e.message);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [offer, filters.source, filters.from, filters.to]);
  const notify = (message: string) => setToast(message);
  const collect = async () => {
    setBusy(true);
    try {
      await api("/api/collect", { method: "POST", body: "{}" });
      await loadBoot();
      notify("Сбор запущен. Результаты появятся в журнале.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cats = boot?.categories ?? [];
  const categoryName =
    filters.category === "all"
      ? "Все категории"
      : cats
          .filter((c) => filters.category.split(",").includes(c.id))
          .map((c) => c.name)
          .join(", ");
  const graph = useMemo(() => {
    const days = new Map<string, Record<string, string | number | null>>();
    const ids = [...new Set(data?.series.map((s) => s.category))];
    const start = Date.parse(filters.from),
      end = Date.parse(filters.to);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end - start > 366 * 86400000
    )
      return [];
    for (let t = start; t <= end; t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      days.set(day, {
        day,
        ...Object.fromEntries(ids.map((id) => [id, null])),
      });
    }
    for (const row of data?.series ?? []) {
      const point = days.get(row.day);
      if (point) point[row.category] = row[metric];
    }
    return [...days.values()];
  }, [data, metric, filters.from, filters.to]);
  const activeCats = cats.filter((c) =>
    data?.series.some((s) => s.category === c.id),
  );
  const change = (key: "median" | "count" | "sellers") => {
    if (!data || !data.previous[key] || data.stats[key] == null) return null;
    return (
      ((data.stats[key]! - data.previous[key]!) / data.previous[key]!) * 100
    );
  };
  const toggleFav = (id: string) =>
    setFavorites((f) =>
      f.includes(id) ? f.filter((x) => x !== id) : [...f, id],
    );
  const filteredOffers = onlyFavorites
    ? data?.offers.filter((o) => favorites.includes(o.offer_id))
    : data?.offers;
  const exportCsv = async () => {
    try {
      const res = await fetch(`/api/export?${query(filters)}`);
      if (!res.ok) throw Error("Не удалось экспортировать данные");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `funpay-${filters.source}-${filters.from}-${filters.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("CSV выгружен с текущими фильтрами");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const presetsSection = (
    <>
      <div className="nav-caption">
        СОХРАНЁННЫЕ ВИДЫ{" "}
        <button
          className="icon-button"
          aria-label="Сохранить текущий вид"
          onClick={() => setSaveOpen(true)}
        >
          <Plus size={15} />
        </button>
      </div>
      {presets.length ? (
        presets.map((p, i) => (
          <div className="saved-row" key={i}>
            <button
              onClick={() => {
                setFilters({ ...initial, ...p.filters, page: 1 });
                setTab("overview");
              }}
            >
              <Bookmark size={15} />
              <span>{p.name}</span>
            </button>
            <button
              aria-label={`Удалить ${p.name}`}
              onClick={() => setPresets(presets.filter((_, j) => j !== i))}
            >
              <X size={13} />
            </button>
          </div>
        ))
      ) : (
        <p className="nav-hint">
          Сохраните фильтры, чтобы
          <br />
          быстро вернуться к анализу.
        </p>
      )}
    </>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("overview");
          }}
        >
          <span className="brand-icon">
            <ScanLine size={25} />
          </span>
          <span>
            market<span className="brand-light">lens</span>
            <small>FUNPAY ANALYTICS</small>
          </span>
        </a>
        <div className="workspace">
          <span className="dota-symbol">◈</span>
          <div>
            Dota 2<small>Исследование рынка</small>
          </div>
          <span className="workspace-dot" />
        </div>
        <div className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav>
          {[
            ["overview", "Обзор рынка", LayoutDashboard],
            ["offers", "Предложения", Layers3],
            ["sellers", "Продавцы", Users],
            ["collector", "Сбор данных", Database],
          ].map(([id, label, Icon]) => (
            <button
              key={String(id)}
              className={tab === id ? "nav-item active" : "nav-item"}
              onClick={() => setTab(String(id))}
            >
              <Icon size={19} />
              <span>{String(label)}</span>
              {id === "collector" && boot?.collector.running && (
                <span className="live-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        {presetsSection}
        <div className="sidebar-bottom">
          <div className="collector-mini">
            <span
              className={boot?.settings.scheduled ? "live-dot" : "idle-dot"}
            />
            <div>
              {boot?.collector.running
                ? "Собираем данные"
                : boot?.settings.scheduled
                  ? "Мониторинг включён"
                  : "Мониторинг на паузе"}
              <small>
                {boot?.settings.scheduled
                  ? `Каждые ${boot.settings.intervalMinutes} мин`
                  : "Настройте расписание сбора"}
              </small>
            </div>
          </div>
          <button className="profile" onClick={() => setTab("collector")}>
            <span className="avatar">ML</span>
            <span>
              Мой анализатор<small>Личное пространство</small>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Рабочее пространство <ChevronRight size={13} />
            <strong>Dota 2</strong>
          </div>
          <div className="topbar-right">
            <span className="local-time">
              <Clock3 size={14} /> UTC+3 · Москва
            </span>
            <button
              className={`source-switch ${filters.source}`}
              onClick={() =>
                update({ source: filters.source === "demo" ? "live" : "demo" })
              }
            >
              <span />
              {filters.source === "demo" ? "Демо-данные" : "Реальные данные"}
              <RefreshCw size={12} />
            </button>
            <span className="user-circle">Ю</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> DOTA 2 / MARKET INTELLIGENCE
              </div>
              <h1>
                {tab === "collector"
                  ? "Центр сбора данных"
                  : tab === "sellers"
                    ? "Продавцы рынка"
                    : tab === "offers"
                      ? "Все предложения"
                      : "Обзор рынка"}
              </h1>
              <p>
                {tab === "collector"
                  ? "Постоянный мониторинг начинается с правильной настройки."
                  : "Замечайте изменения. Сравнивайте цены. Находите возможности."}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button"
                onClick={exportCsv}
                disabled={!data?.stats.count || loading}
              >
                <Download size={16} /> Экспорт CSV
              </button>
              <button
                className="button primary"
                onClick={collect}
                disabled={busy || boot?.collector.running}
              >
                <RefreshCw
                  size={16}
                  className={boot?.collector.running ? "spinning" : ""}
                />
                {boot?.collector.running ? "Собираем…" : "Собрать сейчас"}
              </button>
            </div>
          </div>
          {filters.source === "demo" && tab !== "collector" && (
            <div className="demo-banner">
              <Sparkles size={16} />
              <span>
                <strong>Демонстрационный режим.</strong> Синтетическая история
                за 30 дней для знакомства с аналитикой.
              </span>
              <button onClick={() => update({ source: "live" })}>
                К реальным данным <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {tab === "collector" ? (
            <Collector boot={boot} onRefresh={loadBoot} notify={notify} />
          ) : (
            <>
              <section className="filter-card">
                <div className="filter-main">
                  <label className="category-field">
                    <span>Категория</span>
                    <select
                      value={filters.category}
                      onChange={(e) =>
                        update({
                          ...accountFilterDefaults,
                          sort: "price_asc",
                          category: e.target.value,
                          attribute: "",
                          value: "",
                        })
                      }
                    >
                      <option value="all">Все категории Dota 2</option>
                      {cats.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="filter-separator" />
                  <div className="date-field">
                    <span>Период наблюдения</span>
                    <div>
                      <CalendarDays size={16} />
                      <input
                        aria-label="Начало периода"
                        type="date"
                        value={filters.from}
                        max={filters.to}
                        onChange={(e) => update({ from: e.target.value })}
                      />
                      <span>—</span>
                      <input
                        aria-label="Конец периода"
                        type="date"
                        value={filters.to}
                        min={filters.from}
                        max={today}
                        onChange={(e) => update({ to: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="period-presets">
                    {[7, 30, 90].map((days) => (
                      <button
                        key={days}
                        className={
                          filters.from ===
                            dateKey(
                              new Date(Date.now() - (days - 1) * 86400000),
                            ) && filters.to === today
                            ? "selected"
                            : ""
                        }
                        onClick={() =>
                          update({
                            from: dateKey(
                              new Date(Date.now() - (days - 1) * 86400000),
                            ),
                            to: today,
                          })
                        }
                      >
                        {days}д
                      </button>
                    ))}
                  </div>
                  <button
                    className={`button filter-button ${advanced ? "pressed" : ""}`}
                    onClick={() => setAdvanced(!advanced)}
                  >
                    <SlidersHorizontal size={16} /> Фильтры
                    {(filters.min ||
                      filters.max ||
                      filters.reviews ||
                      filters.online === "1" ||
                      filters.value) && <span className="filter-indicator" />}
                  </button>
                  <button
                    className="icon-button save-button"
                    aria-label="Сохранить вид"
                    title="Сохранить вид"
                    onClick={() => setSaveOpen(true)}
                  >
                    <Bookmark size={18} />
                  </button>
                </div>
                {filters.category === "accounts" && (
                  <AccountFilters
                    filters={filters}
                    onChange={update}
                    expanded={advanced}
                  />
                )}
                {advanced && (
                  <div className="advanced-filters">
                    <label>
                      Цена от, ₽
                      <input
                        type="number"
                        min="0"
                        placeholder="0"
                        value={filters.min}
                        onChange={(e) => update({ min: e.target.value })}
                      />
                    </label>
                    <label>
                      Цена до, ₽
                      <input
                        type="number"
                        min="0"
                        placeholder="Без ограничений"
                        value={filters.max}
                        onChange={(e) => update({ max: e.target.value })}
                      />
                    </label>
                    <label>
                      Отзывов у продавца
                      <select
                        value={filters.reviews}
                        onChange={(e) => update({ reviews: e.target.value })}
                      >
                        <option value="">Любое количество</option>
                        <option value="50">От 50</option>
                        <option value="100">От 100</option>
                        <option value="500">От 500</option>
                        <option value="1000">От 1 000</option>
                      </select>
                    </label>
                    <label>
                      Параметр лота
                      <select
                        value={filters.attribute}
                        onChange={(e) =>
                          update({ attribute: e.target.value, value: "" })
                        }
                      >
                        <option value="">Все параметры</option>
                        {[...new Set(data?.facets.map((f) => f.key))]
                          .filter(
                            (k) =>
                              filters.category !== "accounts" ||
                              ![
                                "type1",
                                "type",
                                "solommr",
                                "decency",
                                "politeness",
                                "games",
                                "time",
                                "auto",
                              ].includes(k) ||
                              filters.attribute === k,
                          )
                          .map((k) => (
                            <option key={k} value={k}>
                              {k === "mmr"
                                ? "Рейтинг MMR"
                                : k === "region"
                                  ? "Регион"
                                  : attributeLabel(k)}
                            </option>
                          ))}
                      </select>
                    </label>
                    {filters.attribute && (
                      <label>
                        Значение
                        <select
                          value={filters.value}
                          onChange={(e) => update({ value: e.target.value })}
                        >
                          <option value="">Все значения</option>
                          {data?.facets
                            .filter((f) => f.key === filters.attribute)
                            .map((f) => (
                              <option key={f.value}>{f.value}</option>
                            ))}
                        </select>
                      </label>
                    )}
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={filters.online === "1"}
                        onChange={(e) =>
                          update({ online: e.target.checked ? "1" : "all" })
                        }
                      />{" "}
                      Онлайн в снимке
                    </label>
                    <button
                      className="text-button"
                      onClick={() =>
                        update({
                          ...accountFilterDefaults,
                          min: "",
                          max: "",
                          reviews: "",
                          online: "all",
                          attribute: "",
                          value: "",
                          q: "",
                        })
                      }
                    >
                      Сбросить
                    </button>
                  </div>
                )}
              </section>
              <div className="section-meta">
                <span>
                  <span className="status-dot" />{" "}
                  {categoryName || "Выбранная категория"}
                  <span className="meta-divider">/</span>
                  {number(data?.snapshots)} снимков за период
                </span>
                <span>
                  {loading ? (
                    <>
                      <LoaderCircle size={13} className="spinning" />{" "}
                      Обновление…
                    </>
                  ) : (
                    <>
                      <Check size={13} />{" "}
                      {filters.source === "demo"
                        ? "Демо-выборка"
                        : "По сохранённым снимкам"}
                    </>
                  )}
                </span>
              </div>
              {error && (
                <div className="error-panel" role="alert">
                  <Info size={18} />
                  {error}
                  <button
                    onClick={() => {
                      if (!ready)
                        loadBoot()
                          .then(() => setReady(true))
                          .catch((e) => setError(e.message));
                      else setRefresh((n) => n + 1);
                    }}
                  >
                    Повторить
                  </button>
                </div>
              )}
              {loading && !data ? (
                <div className="loading-panel">
                  <LoaderCircle className="spinning" /> Загружаем аналитику…
                </div>
              ) : (
                data && (
                  <div
                    className={
                      loading ? "data-content is-loading" : "data-content"
                    }
                    aria-busy={loading}
                  >
                    <div className="stat-grid">
                      <Stat
                        label="Медианная цена"
                        value={money(data.stats.median)}
                        delta={change("median")}
                        Icon={BarChart3}
                        note="к предыдущему периоду"
                        spark="price"
                      />
                      <Stat
                        label="Предложения"
                        value={number(data.stats.count)}
                        delta={change("count")}
                        Icon={Layers3}
                        note="в последних снимках"
                        spark="offers"
                      />
                      <Stat
                        label="Продавцы"
                        value={number(data.stats.sellers)}
                        delta={change("sellers")}
                        Icon={Users}
                        note="уникальных в выборке"
                        spark="sellers"
                      />
                      <Stat
                        label="Диапазон цен"
                        value={`${number(data.stats.minimum)} — ${money(data.stats.maximum)}`}
                        Icon={Target}
                        note={`Средняя цена: ${money(data.stats.average)}`}
                        wide
                      />
                    </div>
                    {!data.stats.count && (
                      <div className="empty-state">
                        <div className="empty-icon">
                          <Database size={30} />
                        </div>
                        <h2>
                          {data.snapshots
                            ? "По этим фильтрам ничего не найдено"
                            : "История начинается с первого снимка"}
                        </h2>
                        <p>
                          {data.snapshots
                            ? "Расширьте диапазон цены или измените параметры лотов."
                            : "В выбранном периоде пока нет данных. Запустите сбор и включите расписание — графики будут пополняться со временем."}
                        </p>
                        <button
                          className="button primary"
                          onClick={() =>
                            data.snapshots
                              ? update({
                                  q: "",
                                  ...accountFilterDefaults,
                                  min: "",
                                  max: "",
                                  reviews: "",
                                  online: "all",
                                  attribute: "",
                                  value: "",
                                })
                              : setTab("collector")
                          }
                        >
                          {data.snapshots
                            ? "Сбросить фильтры"
                            : "Настроить сбор"}{" "}
                          <ArrowUpRight size={15} />
                        </button>
                      </div>
                    )}
                    {data.stats.count > 0 && (
                      <>
                        {tab === "overview" && (
                          <>
                            <div className="charts-grid">
                              <section className="panel price-panel">
                                <div className="panel-heading">
                                  <div>
                                    <h2>
                                      Динамика рынка{" "}
                                      <span className="subtle-badge">
                                        {metric === "count" ? "лоты" : "₽"}
                                      </span>
                                    </h2>
                                    <p>
                                      Последний снимок каждого дня · московское
                                      время
                                    </p>
                                  </div>
                                  <div className="segmented">
                                    <button
                                      className={
                                        metric === "median" ? "selected" : ""
                                      }
                                      onClick={() => setMetric("median")}
                                    >
                                      Медиана
                                    </button>
                                    <button
                                      className={
                                        metric === "minimum" ? "selected" : ""
                                      }
                                      onClick={() => setMetric("minimum")}
                                    >
                                      Минимум
                                    </button>
                                    <button
                                      className={
                                        metric === "count" ? "selected" : ""
                                      }
                                      onClick={() => setMetric("count")}
                                    >
                                      Лоты
                                    </button>
                                  </div>
                                </div>
                                <div className="chart-legend">
                                  {activeCats.map((c) => (
                                    <span key={c.id}>
                                      <i style={{ background: c.color }} />
                                      {c.name}
                                    </span>
                                  ))}
                                </div>
                                <div className="chart-area">
                                  <ResponsiveContainer
                                    width="100%"
                                    height="100%"
                                  >
                                    <AreaChart
                                      data={graph}
                                      margin={{
                                        top: 10,
                                        right: 15,
                                        left: 0,
                                        bottom: 5,
                                      }}
                                    >
                                      <defs>
                                        {activeCats.map((c) => (
                                          <linearGradient
                                            key={c.id}
                                            id={`fill-${c.id}`}
                                            x1="0"
                                            y1="0"
                                            x2="0"
                                            y2="1"
                                          >
                                            <stop
                                              offset="0%"
                                              stopColor={c.color}
                                              stopOpacity={0.28}
                                            />
                                            <stop
                                              offset="100%"
                                              stopColor={c.color}
                                              stopOpacity={0.015}
                                            />
                                          </linearGradient>
                                        ))}
                                      </defs>
                                      <CartesianGrid
                                        strokeDasharray="3 5"
                                        vertical={false}
                                        stroke="#e9edf0"
                                      />
                                      <XAxis
                                        dataKey="day"
                                        tickFormatter={(v) =>
                                          `${v.slice(8)}.${v.slice(5, 7)}`
                                        }
                                        axisLine={false}
                                        tickLine={false}
                                        tickMargin={14}
                                        minTickGap={35}
                                      />
                                      <YAxis
                                        tickFormatter={compact}
                                        axisLine={false}
                                        tickLine={false}
                                        width={49}
                                      />
                                      <Tooltip
                                        contentStyle={tooltipStyle}
                                        labelFormatter={(label) =>
                                          String(label)
                                        }
                                        formatter={(v, name) => [
                                          metric === "count"
                                            ? number(Number(v))
                                            : money(Number(v)),
                                          cats.find((c) => c.id === name)
                                            ?.name ?? name,
                                        ]}
                                      />
                                      {activeCats.map((c) => (
                                        <Area
                                          key={c.id}
                                          type="monotone"
                                          dataKey={c.id}
                                          stroke={
                                            c.color === "#71d9b0"
                                              ? "#20a678"
                                              : c.color
                                          }
                                          fill={`url(#fill-${c.id})`}
                                          strokeWidth={2.5}
                                          connectNulls={false}
                                          dot={
                                            data.series.filter(
                                              (row) => row.category === c.id,
                                            ).length === 1
                                              ? { r: 4 }
                                              : false
                                          }
                                          activeDot={{
                                            r: 5,
                                            strokeWidth: 3,
                                            stroke: "white",
                                          }}
                                        />
                                      ))}
                                    </AreaChart>
                                  </ResponsiveContainer>
                                </div>
                                <div className="chart-footer">
                                  <Info size={13} />
                                  {metric === "median"
                                    ? "Медиана меньше зависит от аномально дорогих предложений."
                                    : metric === "minimum"
                                      ? "Самая низкая цена среди предложений, подходящих под фильтры."
                                      : "Количество доступных объявлений в сохранённой выборке."}
                                </div>
                              </section>
                              <section className="panel distribution">
                                <div className="panel-heading">
                                  <div>
                                    <h2>Распределение цен</h2>
                                    <p>Предложения по ценовым диапазонам</p>
                                  </div>
                                  <BarChart3 size={18} />
                                </div>
                                <div className="distribution-metric">
                                  <strong>{money(data.stats.median)}</strong>
                                  <span>медиана выборки</span>
                                </div>
                                <div className="histogram">
                                  <ResponsiveContainer
                                    width="100%"
                                    height="100%"
                                  >
                                    <BarChart
                                      data={data.histogram.map((h) => ({
                                        ...h,
                                        label: money(h.from),
                                      }))}
                                      margin={{
                                        top: 8,
                                        right: 8,
                                        left: -30,
                                        bottom: 0,
                                      }}
                                    >
                                      <CartesianGrid
                                        vertical={false}
                                        strokeDasharray="3 5"
                                        stroke="#e9edf0"
                                      />
                                      <XAxis
                                        dataKey="from"
                                        tickFormatter={(v) =>
                                          v >= 1000
                                            ? `${(v / 1000).toFixed(1)}к`
                                            : number(v)
                                        }
                                        tickLine={false}
                                        axisLine={false}
                                        minTickGap={30}
                                      />
                                      <YAxis
                                        tickLine={false}
                                        axisLine={false}
                                      />
                                      <Tooltip
                                        contentStyle={tooltipStyle}
                                        labelFormatter={(_, payload) => {
                                          const p = payload?.[0]?.payload;
                                          return p
                                            ? `${money(p.from)} — ${money(p.to)}`
                                            : "";
                                        }}
                                        formatter={(v) => [
                                          number(Number(v)),
                                          "Предложения",
                                        ]}
                                      />
                                      <Bar
                                        dataKey="count"
                                        fill="#62c9a4"
                                        radius={[4, 4, 0, 0]}
                                        maxBarSize={35}
                                      />
                                    </BarChart>
                                  </ResponsiveContainer>
                                </div>
                                <div className="quartiles">
                                  <div>
                                    <span>Нижний квартиль</span>
                                    <strong>{money(data.stats.p25)}</strong>
                                  </div>
                                  <div>
                                    <span>Верхний квартиль</span>
                                    <strong>{money(data.stats.p75)}</strong>
                                  </div>
                                </div>
                              </section>
                            </div>
                            {filters.category === "all" && (
                              <section className="panel comparison">
                                <div className="panel-heading">
                                  <div>
                                    <h2>Сравнение категорий</h2>
                                    <p>
                                      Цены относятся к разным товарам и единицам
                                      услуги
                                    </p>
                                  </div>
                                </div>
                                <div className="comparison-grid">
                                  {data.comparison.map((c) => (
                                    <button
                                      key={c.category}
                                      onClick={() =>
                                        update({
                                          category: c.category,
                                          attribute: "",
                                          value: "",
                                        })
                                      }
                                    >
                                      <span>
                                        <i
                                          style={{
                                            background: cats.find(
                                              (x) => x.id === c.category,
                                            )?.color,
                                          }}
                                        />
                                        {
                                          cats.find((x) => x.id === c.category)
                                            ?.name
                                        }
                                      </span>
                                      <strong>{money(c.median)}</strong>
                                      <small>
                                        {number(c.count)} предложений{" "}
                                        <ArrowUpRight size={13} />
                                      </small>
                                    </button>
                                  ))}
                                </div>
                              </section>
                            )}
                          </>
                        )}
                        {tab === "sellers" ? (
                          <section className="panel">
                            <div className="panel-heading">
                              <div>
                                <h2>Продавцы в выборке</h2>
                                <p>
                                  Топ-12 по количеству предложений · отзывы
                                  относятся ко всему профилю
                                </p>
                              </div>
                              <Users size={20} />
                            </div>
                            <div className="table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Продавец</th>
                                    <th>Предложения</th>
                                    <th>Медианная цена</th>
                                    <th>Отзывы</th>
                                    <th>Статус в снимке</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {data.sellers.map((s, i) => (
                                    <tr key={s.seller_id}>
                                      <td>
                                        <div className="seller-cell">
                                          <span
                                            className="seller-avatar"
                                            style={{
                                              background: avatarColors[i % 4],
                                            }}
                                          >
                                            {s.seller.slice(0, 2).toUpperCase()}
                                          </span>
                                          <strong>{s.seller}</strong>
                                        </div>
                                      </td>
                                      <td>{number(s.count)}</td>
                                      <td className="price-cell">
                                        {money(s.median)}
                                      </td>
                                      <td>
                                        <Star size={12} /> {number(s.reviews)}
                                      </td>
                                      <td>
                                        <span
                                          className={
                                            s.online
                                              ? "online-label"
                                              : "offline-label"
                                          }
                                        >
                                          {s.online
                                            ? "Был онлайн"
                                            : "Был офлайн"}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </section>
                        ) : (
                          <section className="panel offers-panel">
                            <div className="panel-heading">
                              <div>
                                <h2>
                                  {tab === "overview"
                                    ? "Предложения в выборке"
                                    : "Каталог предложений"}{" "}
                                  <span className="count-badge">
                                    {number(data.stats.count)}
                                  </span>
                                </h2>
                                <p>
                                  Последний доступный снимок каждой категории в
                                  выбранном периоде
                                </p>
                              </div>
                              <button
                                className={`icon-button ${onlyFavorites ? "favorite" : ""}`}
                                title="Избранное на текущей странице"
                                aria-label="Избранное на текущей странице"
                                onClick={() => setOnlyFavorites(!onlyFavorites)}
                              >
                                <Star
                                  size={18}
                                  fill={onlyFavorites ? "currentColor" : "none"}
                                />
                              </button>
                            </div>
                            <div className="table-toolbar">
                              <label className="search-box">
                                <Search size={16} />
                                <input
                                  aria-label="Поиск по описанию или продавцу"
                                  placeholder="Поиск по описанию или продавцу…"
                                  value={filters.q}
                                  onChange={(e) =>
                                    update({ q: e.target.value })
                                  }
                                />
                                {filters.q && (
                                  <button
                                    aria-label="Очистить поиск"
                                    onClick={() => update({ q: "" })}
                                  >
                                    <X size={14} />
                                  </button>
                                )}
                              </label>
                              <select
                                aria-label="Сортировка предложений"
                                value={filters.sort}
                                onChange={(e) =>
                                  update({ sort: e.target.value })
                                }
                              >
                                <option value="price_asc">
                                  Сначала дешевле
                                </option>
                                <option value="price_desc">
                                  Сначала дороже
                                </option>
                                <option value="reviews_desc">
                                  Больше отзывов
                                </option>
                                <option value="title">По названию</option>
                                {filters.category === "accounts" && (
                                  <>
                                    <option value="mmr_asc">
                                      MMR: по возрастанию
                                    </option>
                                    <option value="mmr_desc">
                                      MMR: по убыванию
                                    </option>
                                    <option value="decency_desc">
                                      Выше порядочность
                                    </option>
                                    <option value="politeness_desc">
                                      Выше вежливость
                                    </option>
                                    <option value="games_desc">
                                      Больше матчей
                                    </option>
                                    <option value="hours_desc">
                                      Больше часов
                                    </option>
                                  </>
                                )}
                              </select>
                            </div>
                            <div className="table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    <th className="star-cell" />
                                    <th>Предложение</th>
                                    {filters.category === "accounts" && (
                                      <th>
                                        <button
                                          className="column-sort"
                                          onClick={() =>
                                            update({
                                              sort:
                                                filters.sort === "mmr_desc"
                                                  ? "mmr_asc"
                                                  : "mmr_desc",
                                            })
                                          }
                                        >
                                          MMR{" "}
                                          {filters.sort === "mmr_asc" ? (
                                            <ArrowUp size={12} />
                                          ) : filters.sort === "mmr_desc" ? (
                                            <ArrowDown size={12} />
                                          ) : (
                                            <SlidersHorizontal size={11} />
                                          )}
                                        </button>
                                      </th>
                                    )}
                                    <th>Продавец</th>
                                    <th>
                                      Цена <ArrowDown size={11} />
                                    </th>
                                    <th>В снимке</th>
                                    <th />
                                  </tr>
                                </thead>
                                <tbody>
                                  {filteredOffers?.map((o, i) => (
                                    <tr key={o.offer_id}>
                                      <td className="star-cell">
                                        <button
                                          className={`icon-button ${favorites.includes(o.offer_id) ? "favorite" : ""}`}
                                          aria-label="Добавить или убрать из избранного"
                                          onClick={() => toggleFav(o.offer_id)}
                                        >
                                          <Star
                                            size={15}
                                            fill={
                                              favorites.includes(o.offer_id)
                                                ? "currentColor"
                                                : "none"
                                            }
                                          />
                                        </button>
                                      </td>
                                      <td className="offer-title-cell">
                                        <button
                                          className="offer-title"
                                          onClick={() => setOffer(o)}
                                        >
                                          {o.title}
                                        </button>
                                        <div className="tags">
                                          <span
                                            className="category-tag"
                                            style={{
                                              color:
                                                o.color === "#71d9b0"
                                                  ? "#278367"
                                                  : o.color,
                                            }}
                                          >
                                            {o.category}
                                          </span>
                                          {offerTags(o.attributes).map(
                                            ({ key, text }) => (
                                              <span key={key}>{text}</span>
                                            ),
                                          )}
                                        </div>
                                      </td>
                                      {filters.category === "accounts" && (
                                        <td className="mmr-cell">
                                          {number(numericMmr(o.attributes))}
                                        </td>
                                      )}
                                      <td>
                                        <div className="seller-cell">
                                          <span
                                            className="seller-avatar"
                                            style={{
                                              background: avatarColors[i % 4],
                                            }}
                                          >
                                            {o.seller.slice(0, 2).toUpperCase()}
                                          </span>
                                          <div>
                                            <strong>{o.seller}</strong>
                                            <small>
                                              <Star size={10} />{" "}
                                              {number(o.reviews)} отзывов
                                            </small>
                                          </div>
                                        </div>
                                      </td>
                                      <td className="price-cell">
                                        {money(o.price)}
                                      </td>
                                      <td>
                                        <span
                                          className={
                                            o.online
                                              ? "online-label"
                                              : "offline-label"
                                          }
                                        >
                                          <i />
                                          {o.online ? "Онлайн" : "Офлайн"}
                                        </span>
                                      </td>
                                      <td>
                                        <button
                                          aria-label="Открыть историю предложения"
                                          className="icon-button"
                                          onClick={() => setOffer(o)}
                                        >
                                          <ArrowUpRight size={17} />
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {!filteredOffers?.length && (
                                <div className="table-empty">
                                  На этой странице нет избранных предложений.
                                </div>
                              )}
                            </div>
                            <div className="table-footer">
                              <span>
                                {onlyFavorites
                                  ? "Избранное на текущей странице"
                                  : `${number((data.page - 1) * 12 + 1)}–${number(Math.min(data.page * 12, data.stats.count))} из ${number(data.stats.count)} предложений`}
                              </span>
                              <div>
                                <button
                                  className="icon-button"
                                  aria-label="Предыдущая страница"
                                  disabled={data.page <= 1 || loading}
                                  onClick={() =>
                                    setFilters((f) => ({
                                      ...f,
                                      page: data.page - 1,
                                    }))
                                  }
                                >
                                  <ChevronLeft size={17} />
                                </button>
                                <span className="page-number">{data.page}</span>
                                <span className="pages-total">
                                  / {data.pages}
                                </span>
                                <button
                                  className="icon-button"
                                  aria-label="Следующая страница"
                                  disabled={data.page >= data.pages || loading}
                                  onClick={() =>
                                    setFilters((f) => ({
                                      ...f,
                                      page: data.page + 1,
                                    }))
                                  }
                                >
                                  <ChevronRight size={17} />
                                </button>
                              </div>
                            </div>
                          </section>
                        )}
                      </>
                    )}
                    <section className="data-note">
                      <ShieldCheck size={18} />
                      <div>
                        <strong>Прозрачность данных</strong>
                        <p>
                          Это цены предложений, а не совершённых сделок. История
                          накапливается с момента запуска сбора.
                          {data.coverage.some(
                            (c) => c.coverage !== null && c.coverage < 1,
                          ) &&
                            " FunPay отдаёт неполную выборку: показатели не охватывают весь рынок."}
                          {data.missing.length > 0 &&
                            ` Нет снимков для ${data.missing.length} выбранных категорий.`}
                        </p>
                        {data.coverage.length > 0 && (
                          <div className="coverage-tags">
                            {data.coverage.map((c) => (
                              <span
                                key={c.id}
                                title={`Снимок: ${dateLabel(c.collected_at)}. Пропущено строк: ${c.skipped}`}
                              >
                                {c.name}: {number(c.total)} /{" "}
                                {c.advertised ? number(c.advertised) : "?"}{" "}
                                <b>
                                  {c.coverage === null
                                    ? "покрытие неизвестно"
                                    : `${Math.round(c.coverage * 100)}%`}
                                </b>
                                <small>{dateLabel(c.collected_at)}</small>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                  </div>
                )
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              marketlens <span> / </span> Независимая аналитика FunPay
            </span>
            <span>
              Наблюдайте за рынком осознанно <Activity size={13} />
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Info size={17} />
          {toast}
          <button
            className="icon-button"
            aria-label="Закрыть уведомление"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {saveOpen && (
        <div className="modal-backdrop" onClick={() => setSaveOpen(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (saveName.trim()) {
                setPresets((p) => [...p, { name: saveName.trim(), filters }]);
                setSaveOpen(false);
                setSaveName("");
                notify("Вид сохранён в этом браузере");
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-title"
          >
            <button
              type="button"
              className="modal-close icon-button"
              onClick={() => setSaveOpen(false)}
              aria-label="Закрыть"
            >
              <X size={18} />
            </button>
            <Bookmark size={24} />
            <h2 id="save-title">Сохранить вид</h2>
            <p>Категория, период и все фильтры будут под рукой.</p>
            <label>
              Название
              <input
                autoFocus
                required
                maxLength={40}
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Например, аккаунты EU до 5 000 ₽"
              />
            </label>
            <button className="button primary" type="submit">
              Сохранить вид
            </button>
          </form>
        </div>
      )}
      {offer && (
        <div
          className="modal-backdrop drawer-backdrop"
          onClick={() => setOffer(null)}
        >
          <section
            className="offer-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="offer-heading"
          >
            <button
              className="modal-close icon-button"
              aria-label="Закрыть"
              onClick={() => setOffer(null)}
            >
              <X size={20} />
            </button>
            <span className="eyebrow">ИСТОРИЯ ПРЕДЛОЖЕНИЯ</span>
            <h2 id="offer-heading">{offer.title}</h2>
            <div className="drawer-price">{money(offer.price)}</div>
            <p>
              Продавец: <strong>{offer.seller}</strong> ·{" "}
              {number(offer.reviews)} отзывов
            </p>
            <p className="muted">
              Снимок от {dateLabel(offer.collected_at)} · UTC+3
            </p>
            <div className="drawer-attrs">
              {Object.entries(offer.attributes).map(([k, v]) => (
                <div key={k}>
                  <span>{attributeLabel(k)}</span>
                  <strong>{attributeDisplay(k, v)}</strong>
                </div>
              ))}
            </div>
            <h3>Изменение цены за период</h3>
            {historyError ? (
              <p role="alert">{historyError}</p>
            ) : historyLoading ? (
              <p>Загрузка истории…</p>
            ) : history.length ? (
              <div className="drawer-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={history}>
                    <XAxis
                      dataKey="collected_at"
                      tickFormatter={(v) => dateLabel(v).split(",")[0]}
                      minTickGap={45}
                    />
                    <YAxis width={55} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => dateLabel(String(v))}
                      formatter={(v) => [money(Number(v)), "Цена"]}
                    />
                    <Area
                      type="stepAfter"
                      dataKey="price"
                      stroke="#209b74"
                      fill="#d8f0e7"
                      dot={history.length === 1}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p>В этом периоде история отсутствует.</p>
            )}
            <div className="info-box">
              <Info size={17} />
              <span>
                {history.length === 1
                  ? "Пока доступен один снимок. Следующие сборы покажут изменение цены."
                  : "История отражает наблюдаемые цены объявления, а не его продажи."}
              </span>
            </div>
            {filters.source === "live" && (
              <a
                className="button primary"
                href={offer.url}
                target="_blank"
                rel="noreferrer"
              >
                Открыть на FunPay <ExternalLink size={16} />
              </a>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
const avatarColors = ["#e6edf8", "#eee9f5", "#f7ecdc", "#e3f0e8"];
const tooltipStyle = {
  border: "1px solid #e5e9e8",
  borderRadius: 10,
  fontSize: 12,
  boxShadow: "0 8px 32px #172e1f12",
};
function Stat({
  label,
  value,
  delta,
  Icon,
  note,
  wide,
}: {
  label: string;
  value: string;
  delta?: number | null;
  Icon: React.ElementType;
  note: string;
  spark?: string;
  wide?: boolean;
}) {
  return (
    <section className={`stat-card ${wide ? "wide-value" : ""}`}>
      <div className="stat-label">
        {label}
        <Icon size={17} />
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">
        {delta != null ? (
          <span className={delta >= 0 ? "delta up" : "delta down"}>
            {delta >= 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{" "}
            {Math.abs(delta).toFixed(1)}%
          </span>
        ) : (
          !wide && <span className="neutral-delta">—</span>
        )}
        <span>{delta == null && !wide ? "Нет прошлого периода" : note}</span>
      </div>
    </section>
  );
}

function Collector({
  boot,
  onRefresh,
  notify,
}: {
  boot: Bootstrap | null;
  onRefresh: () => Promise<Bootstrap>;
  notify: (s: string) => void;
}) {
  const [form, setForm] = useState<Settings | undefined>(boot?.settings);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!form && boot) setForm(boot.settings);
  }, [boot, form]);
  if (!boot || !form)
    return <div className="loading-panel">Загрузка настроек…</div>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      await onRefresh();
      notify("Расписание сохранено");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api(`/api/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      await onRefresh();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    try {
      await api("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name, url }),
      });
      setName("");
      setUrl("");
      await onRefresh();
      notify("Категория добавлена");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setAdding(false);
    }
  };
  return (
    <div className="collector-layout">
      <section className="panel schedule-panel">
        <div className="panel-heading">
          <div>
            <h2>Автоматический сбор</h2>
            <p>Работает, пока запущен сервер приложения</p>
          </div>
          <Clock3 size={20} />
        </div>
        <form onSubmit={save}>
          <label className="switch-row">
            <span>
              <strong>Сбор по расписанию</strong>
              <small>Первый запуск через заданный интервал</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={form.scheduled}
              onChange={(e) =>
                setForm({ ...form, scheduled: e.target.checked })
              }
            />
          </label>
          <div className="settings-fields">
            <label>
              Интервал сбора
              <select
                value={form.intervalMinutes}
                onChange={(e) =>
                  setForm({ ...form, intervalMinutes: Number(e.target.value) })
                }
              >
                {[15, 30, 60, 120, 360, 720, 1440].map((v) => (
                  <option value={v} key={v}>
                    {v < 60 ? `${v} минут` : `${v / 60} ч`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Хранить историю
              <select
                value={form.retentionDays}
                onChange={(e) =>
                  setForm({ ...form, retentionDays: Number(e.target.value) })
                }
              >
                {[7, 14, 30, 90, 180, 365].map((v) => (
                  <option value={v} key={v}>
                    {v} дней
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="info-box">
            <Info size={16} />
            <span>
              Старые снимки удаляются после сбора. Для начала рекомендуем
              интервал 1 час и хранение 30 дней.
            </span>
          </div>
          <button className="button primary" disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить настройки"}
            <Check size={15} />
          </button>
        </form>
        <div className="next-run">
          <span className={boot.settings.scheduled ? "live-dot" : "idle-dot"} />
          {boot.collector.running
            ? "Сбор выполняется"
            : boot.collector.nextAt
              ? `Следующий сбор: ${dateLabel(boot.collector.nextAt)}`
              : "Расписание выключено"}
        </div>
      </section>
      <section className="panel categories-panel">
        <div className="panel-heading">
          <div>
            <h2>Что отслеживаем</h2>
            <p>Включите нужные разделы Dota 2</p>
          </div>
          <Layers3 size={20} />
        </div>
        <div className="category-settings">
          {boot.categories.map((c) => (
            <label key={c.id} className="switch-row">
              <span>
                <strong>
                  <i style={{ background: c.color }} />
                  {c.name}
                </strong>
                <small>
                  {c.lastCollected
                    ? `Последний снимок: ${dateLabel(c.lastCollected)}`
                    : "Снимков пока нет"}
                </small>
              </span>
              <input
                aria-label={`Отслеживать ${c.name}`}
                className="switch"
                type="checkbox"
                checked={!!c.enabled}
                onChange={(e) => toggle(c.id, e.target.checked)}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="panel add-category">
        <div className="panel-heading">
          <div>
            <h2>Добавить раздел</h2>
            <p>Ссылка на публичную страницу категории FunPay</p>
          </div>
          <Plus size={19} />
        </div>
        <form onSubmit={add}>
          <label>
            Название
            <input
              required
              maxLength={60}
              minLength={2}
              placeholder="Например, другая категория Dota 2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Ссылка
            <input
              required
              type="url"
              placeholder="https://funpay.com/lots/123/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <button className="button" disabled={adding}>
            <Plus size={16} /> Добавить категорию
          </button>
        </form>
      </section>
      <section className="panel runs-panel">
        <div className="panel-heading">
          <div>
            <h2>
              Журнал сбора{" "}
              <span className="count-badge">{boot.runs.length}</span>
            </h2>
            <p>Последние 50 запусков · обновляется каждые 10 секунд</p>
          </div>
          <Activity size={19} />
        </div>
        {boot.runs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Категория</th>
                  <th>Результат</th>
                  <th>Лотов</th>
                </tr>
              </thead>
              <tbody>
                {boot.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{dateLabel(r.started_at)}</td>
                    <td>{r.category ?? "Система"}</td>
                    <td>
                      <span className={`run-status ${r.status}`}>
                        {r.status === "success" ? (
                          <Check size={13} />
                        ) : (
                          <Info size={13} />
                        )}{" "}
                        {r.message}
                      </span>
                    </td>
                    <td>{number(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-empty">
            <Database size={24} />
            <p>Здесь появятся результаты первого сбора.</p>
          </div>
        )}
      </section>
      <div className="data-note collector-note">
        <ShieldCheck size={20} />
        <div>
          <strong>Как устроен сбор</strong>
          <p>
            Один запрос на категорию с паузой 5 секунд между запросами. Только
            публичные объявления в рублях. При блокировке доступа сборщик
            записывает ошибку и ждёт следующего запуска. Частичные выборки
            отмечаются в аналитике.
          </p>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
