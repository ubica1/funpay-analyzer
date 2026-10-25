export type Category = {
  id: string;
  name: string;
  url: string;
  enabled: number;
  color: string;
  lastCollected: string | null;
};
export type Settings = {
  intervalMinutes: number;
  retentionDays: number;
  scheduled: boolean;
};
export type Bootstrap = {
  categories: Category[];
  settings: Settings;
  collector: { running: boolean; nextAt: string | null };
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
export type Filters = {
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
  stats: Stats;
  previous: Stats;
  series: (Stats & { day: string; category: string })[];
  histogram: { from: number; to: number; count: number }[];
  offers: Offer[];
  sellers: {
    seller_id: string;
    seller: string;
    count: number;
    median: number;
    reviews: number;
    online: number;
  }[];
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
  timezone: string;
};
