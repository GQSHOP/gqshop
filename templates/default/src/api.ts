/** API 客户端：统一 {code,msg,data} 包装。 */
const BASE = "/v1";

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
}

/** 分店态：sessionStorage 记忆 slug，自动附加到店面 API（stationMiddleware 按 query 解析）。 */
export function stationQuery(): string {
  const slug = sessionStorage.getItem("gqshop-station");
  return slug ? `&s=${encodeURIComponent(slug)}` : "";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const stationPart = path.startsWith("/shop/") && init?.method !== "POST" ? stationQuery() : "";
  const res = await fetch(BASE + path + stationPart, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await res.json()) as ApiEnvelope<T>;
  if (body.code !== 0) throw new Error(body.msg || `API error ${body.code}`);
  return body.data as T;
}

// ---------- types ----------

export interface Category {
  sid: number;
  sortname: string;
  alias: string;
  taxis: number;
  sorticon: string | null;
  count?: number;
}

export interface GoodsCard {
  id: number;
  title: string;
  type: string | null;
  cover: string | null;
  sales: number | null;
  stock: number | null;
  unit_name: string | null;
  sort_id: number | null;
  min_price: string | number | null;
}

export interface Sku {
  code: string | null;
  sku: string;
  market_price: number | null;
  guest_price: number | null;
  stock: number | null;
  sales: number | null;
}

export interface DiscountRule {
  sku: string;
  quantity: number;
  amount: string;
  type: number;
}

export interface GoodsDetail extends GoodsCard {
  content: string | null;
  gallery: string | null;
  unit_name: string | null;
  skus: Sku[];
  discounts: DiscountRule[];
}

export interface OrderCreated {
  out_trade_no: string;
  amount: number;
  goods: string;
  quantity: number;
}

export interface OrderView {
  order: {
    out_trade_no: string;
    amount: number;
    pay_status: number;
    status: number;
    payment: string | null;
    create_time: string | null;
  };
  items: Array<{ goods_title: string; quantity: number; price: number; status: number }>;
  contents: string[];
}

// ---------- calls ----------

export const getCategories = () => api<Category[]>("/shop/categories");
export type GoodsSort = "default" | "sales" | "price" | "stock";
export const getGoods = (sortId: number, page = 1, keyword = "", sort: GoodsSort = "default") =>
  api<{ list: GoodsCard[]; page: number; limit: number }>(
    `/shop/goods?sort_id=${sortId}&page=${page}&keyword=${encodeURIComponent(keyword)}&sort=${sort}`,
  );
export interface SiteOptions {
  roll_bulletin: string;
  home_bulletin: string;
}
export const getSiteOptions = () => api<SiteOptions>("/shop/site-options");
export const getGoodsDetail = (id: number) => api<GoodsDetail>(`/shop/goods/${id}`);
export interface StationContext {
  station_id: number;
  slug: string;
  name: string;
  title: string;
  site_subtitle: string;
  home_notice: string;
}
export const getStationContext = (slug: string) =>
  api<StationContext>(`/shop/station-context?slug=${encodeURIComponent(slug)}`);
export const createOrder = (body: {
  goods_id: number;
  quantity: number;
  tel: string;
  pay_plugin: string;
  idempotency_key: string;
  address_id?: number;
  station_slug?: string;
}) => api<OrderCreated>("/shop/orders", { method: "POST", body: JSON.stringify(body) });
export const getOrder = (no: string) => api<OrderView>(`/shop/orders/${no}`);
export const mockPay = (no: string, adminKey: string) =>
  api<{ msg: string; delivered: boolean }>("/pay/mock/confirm", {
    method: "POST",
    headers: { "X-Admin-Key": adminKey },
    body: JSON.stringify({ out_trade_no: no }),
  });
