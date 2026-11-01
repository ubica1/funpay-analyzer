import type { AccountFilters } from "./account-fields";
export type Platform = {
  id: string;
  name: string;
  automatic?: boolean;
  browser?: boolean;
  region: "ru" | "foreign";
  currency: "RUB" | "USD";
  url: string;
};
export type Category = {
  platform: string;
  kind: string;
  id: string;
  name: string;
  url: string;
  enabled: number;
  color: string;
  lastCollected: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  lastAttemptAt: string | null;
};
export type Settings = {
  intervalMinutes: number;
  retentionDays: number;
  scheduled: boolean;
};
export type Bootstrap = {
  platforms: Platform[];
  categories: Category[];
  settings: Settings;
  collector: {
    running: boolean;
    nextAt: string | null;
    verifying: boolean;
    completed: number;
    total: number;
    current: string[];
    lastCollection: {
      id: number;
      startedAt: string;
      finishedAt: string | null;
      results: {
        categoryId: string;
        name: string;
        status: "success" | "error";
        count?: number;
        message?: string;
      }[];
    } | null;
  };
  runs: {
    id: number;
    category: string;
    status: string;
    message: string;
    count: number;
    started_at: string;
  }[];
  hasData: boolean;
};
export type Filters = AccountFilters & {
  market: string;
  source: "live" | "demo";
  category: string;
  from: string;
  to: string;
  q: string;
  min: string;
  max: string;
  reviews: string;
  online: "all" | "1";
  attribute: string;
  value: string;
  sort: string;
  page: number;
};
export type Stats = {
  count: number;
  median: number | null;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
  p25: number | null;
  p75: number | null;
  sellers: number;
  online: number | null;
};
export type Offer = {
  offer_id: string;
  title: string;
  price: number;
  seller_id: string;
  seller: string;
  reviews: number;
  online: number;
  attributes: Record<string, string>;
  url: string;
  category: string;
  color: string;
  collected_at: string;
};
export type Analytics = {
  freshness: {
    id: string;
    name: string;
    displayedAt: string | null;
    latestSnapshotAt: string | null;
    lastAttempt: { started_at: string; status: string; message: string } | null;
    failed: boolean;
  }[];
  availableFilters: Record<string, number>;
  availableTotal: number;
  currency: "RUB" | "USD";
  stats: Stats;
  previous: Stats;
  series: (Stats & { day: string; category: string })[];
  histogram: { from: number; to: number; count: number }[];
  offers: Offer[];
  sellers: SellerRow[];
  comparison: (Stats & { category: string })[];
  facets: { key: string; value: string }[];
  coverage: {
    id: number;
    name: string;
    category_id: string;
    collected_at: string;
    total: number;
    advertised: number | null;
    coverage: number | null;
    skipped: number;
  }[];
  missing: string[];
  page: number;
  pages: number;
  snapshots: number;
  sales: Sales;
  timezone: string;
};
export type Sale = {
  platform: string;
  platformName: string;
  offer_id: string;
  title: string;
  price: number;
  seller_id: string;
  seller: string;
  url: string;
  category: string;
  color: string;
  sold_at: string;
  kind: "gone" | "replaced";
  mmr: number | null;
  new_mmr: number | null;
  sale_type: string | null;
};
export type SaleWindow = "day" | "week" | "month";
export type Sales = {
  summary: Record<
    SaleWindow,
    { count: number; median: number | null; total: number }
  >;
  pending: number;
  list: Sale[];
  snapshots: number;
  trackedSince: string | null;
};
export type SellerRow = {
  seller_id: string;
  seller: string;
  count: number;
  median: number | null;
  minimum: number | null;
  reviews: number | null;
  online: number | null;
  sold: number;
  soldMedian: number | null;
};
export type SellerDetail = {
  seller_id: string;
  seller: string;
  series: {
    collected_at: string;
    count: number;
    median: number;
    minimum: number;
  }[];
  lots: (Offer & { mmr: number | null })[];
  sales: Sale[];
  soldMedian: number | null;
};
