/** 管理后台 API 客户端：M5-α 会话票制（admin JWT）；v1.1.1 删除 X-Admin-Key 运维双通道。 */
const TOKEN_STORAGE = "gqshop-admin-token";

export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_STORAGE) ?? "";
}
export function setAdminToken(t: string): void {
  localStorage.setItem(TOKEN_STORAGE, t);
}
export function clearAdminSession(): void {
  localStorage.removeItem(TOKEN_STORAGE);
}
export function hasAdminSession(): boolean {
  return getAdminToken().length > 0;
}

/** 账号密码换取 admin 会话票（8h JWT；不再下发全局 key）。 */
export function adminLogin(username: string, password: string) {
  return fetch("/v1/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).then(async (r) => {
    const b = (await r.json()) as { code: number; msg: string; data?: { token: string; username: string; group_id: number } };
    if (b.code !== 0) throw new Error(b.msg || "登录失败");
    return b.data!;
  });
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getAdminToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch("/v1" + path, { headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) }, ...init });
  if (res.status === 403) throw new Error("会话失效或权限不足，请重新登录");
  const body = (await res.json()) as { code: number; msg: string; data?: T };
  if (body.code !== 0) throw new Error(body.msg || `API ${body.code}`);
  return body.data as T;
}

export interface Stats {
  today_orders: number;
  today_sales: number;
  goods_count: number;
  stock_total: number;
  user_count: number;
  low_stock: Array<{ id: number; title: string; stock: number; type: string }>;
}
export interface AdminGoods {
  id: number;
  title: string;
  type: string;
  is_sku: string;
  is_on_shelf: number;
  stock: number;
  sales: number;
  min_price: string | number | null;
}
export interface AdminOrder {
  out_trade_no: string;
  amount: number;
  pay_status: number;
  status: number;
  payment: string | null;
  tel: string;
  email: string;
  username: string | null;
}
export interface StockDetail {
  goods: { id: number; title: string; type: string; stock: number };
  counts: { once_remaining: number; general_pool: number; service_rows: number };
}

export const getStats = () => call<Stats>("/admin/stats");
export const getGoodsList = (page = 1, keyword = "") =>
  call<{ list: AdminGoods[]; page: number }>(
    `/admin/goods?page=${page}&keyword=${encodeURIComponent(keyword)}`,
  );
export const toggleShelf = (id: number, on: boolean) =>
  call<{ msg: string }>(`/admin/goods/${id}/shelf`, {
    method: "PATCH",
    body: JSON.stringify({ is_on_shelf: on ? 1 : 0 }),
  });
export const createGoods = (body: {
  title: string;
  type: string;
  guest_price: number;
  market_price: number;
  content?: string;
}) => call<{ goods_id: number }>("/admin/goods", { method: "POST", body: JSON.stringify(body) });
export const getStockDetail = (goodsId: number) => call<StockDetail>(`/admin/stock/${goodsId}`);
export const importCards = (goodsId: number, sku: string, cards: string[]) =>
  call<{ added: number }>("/admin/stock/import", {
    method: "POST",
    body: JSON.stringify({ goods_id: goodsId, sku, cards }),
  });
export const getOrders = (page = 1) => call<{ list: AdminOrder[]; page: number }>(`/admin/orders?page=${page}`);

export interface DiscountRule {
  id: number;
  sku: string;
  quantity: number;
  amount: string;
  type: number;
}
export interface AftersaleRow {
  id: number;
  out_trade_no: string;
  goods_title: string;
  type: string;
  reason: string;
  contact: string;
  status: number;
  create_time: number;
}
export interface AftersaleChatMsg {
  sender_type: string;
  content: string;
  create_time: number;
}

export const getDiscountRules = (goodsId: number) => call<DiscountRule[]>(`/admin/discount?goods_id=${goodsId}`);
export const saveDiscountRule = (body: {
  goods_id: number;
  sku: string;
  quantity: number;
  amount: number;
  type: number;
}) => call<unknown>("/admin/discount", { method: "POST", body: JSON.stringify(body) });
export const deleteDiscountRule = (id: number) => call<unknown>(`/admin/discount/${id}`, { method: "DELETE" });
export const getAftersales = () => call<AftersaleRow[]>("/admin/aftersale");
export const replyAftersale = (id: number, content: string, resolve?: boolean) =>
  call<unknown>(`/admin/aftersale/${id}/reply`, {
    method: "POST",
    body: JSON.stringify({ content, resolve }),
  });
export const getAftersaleChat = (id: number) => call<AftersaleChatMsg[]>(`/admin/aftersale/${id}/chat`);
export interface AdminStation {
  id: number;
  user_id: number;
  slug: string;
  name: string | null;
  title: string | null;
  status: number;
  domain: string | null;
  amount: string;
  create_time: string;
  username: string | null;
  level_name: string | null;
  /** 功能池③：插件白名单（null=全允许） */
  plugin_allow: string[] | null;
}
export interface StationStats {
  id: number;
  slug: string;
  name: string | null;
  level_name: string | null;
  service_change: string | null;
  sales_total: string;
  order_count: number;
}
export const getStations = () => call<AdminStation[]>("/admin/station");
export const setStationPluginAllow = (id: number, plugins: string[]) =>
  call<{ msg: string }>(`/admin/station/${id}/plugin-allow`, { method: "PUT", body: JSON.stringify({ plugins }) });
export const setStationStatus = (id: number, status: number) =>
  call<unknown>(`/admin/station/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
export const getStationStats = () => call<StationStats[]>("/admin/station/stats");

export interface ShippingTemplate {
  id: number;
  name: string;
  first_fee: number;
  append_fee: number;
  free_threshold: number;
  status: number;
  description: string;
}
export interface PhysicalSale {
  id: number;
  goods_id: number;
  goods_title: string | null;
  order_list_id: number;
  sku: string;
  num: number;
  receiver_name: string;
  receiver_phone: string;
  region: string;
  address: string;
  buyer_remark: string;
  logistics_company: string;
  logistics_no: string;
  status: number;
  out_trade_no: string | null;
  user_id: number;
}
export const uploadCover = (file: File) => {
  const fd = new FormData();
  fd.append("file", file);
  return fetch("/v1/admin/upload", { method: "POST", headers: { Authorization: `Bearer ${getAdminToken()}` }, body: fd })
    .then(async (r) => {
      const b = (await r.json()) as { code: number; msg: string; data?: { url: string } };
      if (b.code !== 0) throw new Error(b.msg || "upload failed");
      return b.data!.url;
    });
};
export const updateGoods = (id: number, body: { title?: string; cover?: string; content?: string; unit_name?: string; password?: string; pay_content?: string }) =>
  call<{ msg: string }>(`/admin/goods/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export interface PriceRules {
  single_cents: number;
  profit_cents: number;
  markup_percent: number;
  note?: string;
}
export const getPriceRules = () => call<PriceRules>("/admin/price-rules");
export const savePriceRules = (r: { single_cents: number; profit_cents: number; markup_percent: number }) =>
  call<{ msg: string }>("/admin/price-rules", { method: "PUT", body: JSON.stringify(r) });
export const getShippingTemplates = () => call<ShippingTemplate[]>("/admin/shipping-templates");
export const createShippingTemplate = (body: { name: string; first_fee: number; append_fee: number; free_threshold?: number; description?: string }) =>
  call<{ id: number }>("/admin/shipping-templates", { method: "POST", body: JSON.stringify(body) });
export const bindGoodsShipping = (goodsId: number, templateId: number) =>
  call<unknown>(`/admin/goods/${goodsId}/shipping`, { method: "POST", body: JSON.stringify({ template_id: templateId }) });
export const getPhysicalSales = (status?: number) =>
  call<PhysicalSale[]>(`/admin/physical/sales${status !== undefined ? `?status=${status}` : ""}`);
export const shipPhysicalSale = (id: number, logistics_company: string, logistics_no: string) =>
  call<unknown>(`/admin/physical/sales/${id}/ship`, {
    method: "POST",
    body: JSON.stringify({ logistics_company, logistics_no }),
  });

export interface BlogPostRow {
  gid: number;
  title: string;
  alias: string;
  date: string;
  sortid: number;
  sort_name: string | null;
  views: number;
  comnum: number;
  hide: string;
  top: string;
}
export interface BlogCommentRow {
  cid: number;
  gid: number;
  poster: string;
  uid: number;
  username: string | null;
  comment: string;
  hide: string;
  date: string;
}
export const getBlogPosts = () => call<BlogPostRow[]>("/admin/blog/posts");
export const createBlogPost = (body: { title: string; content: string; excerpt?: string; alias?: string; sortid?: number }) =>
  call<{ gid: number }>("/admin/blog/posts", { method: "POST", body: JSON.stringify(body) });
export const updateBlogPost = (gid: number, body: Record<string, unknown>) =>
  call<unknown>(`/admin/blog/posts/${gid}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteBlogPost = (gid: number) =>
  call<unknown>(`/admin/blog/posts/${gid}`, { method: "DELETE" });
export const getBlogComments = () => call<BlogCommentRow[]>("/admin/blog/comments");
export const setBlogCommentHide = (cid: number, hide: string) =>
  call<unknown>(`/admin/blog/comments/${cid}`, { method: "PATCH", body: JSON.stringify({ hide }) });
export const deleteBlogComment = (cid: number) =>
  call<unknown>(`/admin/blog/comments/${cid}`, { method: "DELETE" });

// ---------- M5-α 用户组管理（group.manage） ----------
export interface GroupRow {
  id: number;
  name: string;
  menu_permissions: string;
  member_count: number;
}
export const getGroups = () =>
  call<{ list: GroupRow[]; all_perms: string[] }>("/admin/groups");
export const createGroup = (name: string, perms: string[]) =>
  call<{ id: number }>("/admin/groups", { method: "POST", body: JSON.stringify({ name, perms }) });
export const updateGroup = (id: number, body: { name?: string; perms?: string[] }) =>
  call<unknown>(`/admin/groups/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteGroup = (id: number) =>
  call<unknown>(`/admin/groups/${id}`, { method: "DELETE" });
export const assignMember = (groupId: number, username: string, op: "add" | "remove") =>
  call<unknown>(`/admin/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ username, op }) });

// ---------- M5-β 模板管理（template.manage） ----------
export interface TplView {
  templates: string[];
  current: string;
  templates_root: string;
  available: boolean;
}
export const getTemplates = () => call<TplView>("/admin/templates");
export const setDefaultTemplate = (name: string) =>
  call<{ front_default: string }>("/admin/templates/default", { method: "POST", body: JSON.stringify({ name }) });

// ---------- M5-γ 插件管理（plugin.manage） ----------
export interface PluginRow {
  name: string;
  version: string;
  description: string;
  has_config?: boolean;
}
export interface PluginsView {
  builtin: PluginRow[];
  activated: string[];
  goods_types: Array<{ type: string; label: string; plugin: string }>;
  pay_plugins: Array<{ name: string; label: string; kind: string; plugin: string }>;
  note: string;
}
export const getPlugins = () => call<PluginsView>("/admin/plugins");
export const togglePlugin = (name: string) =>
  call<{ msg: string; active_plugins: string[] }>(`/admin/plugins/${name}/toggle`, { method: "POST" });

// ---------- v1.2.0 插件配置（plugin.manage） ----------
export interface PluginConfigField {
  key: string;
  label: string;
  type: "string" | "password" | "number" | "boolean";
  placeholder?: string;
  hint?: string;
}
export type PluginConfigValue = string | number | boolean;
export const getPluginConfig = (name: string) =>
  call<{ schema: PluginConfigField[]; values: Record<string, PluginConfigValue> }>(`/admin/plugins/${name}/config`);
export const savePluginConfig = (name: string, values: Record<string, PluginConfigValue>) =>
  call<{ msg: string }>(`/admin/plugins/${name}/config`, { method: "PUT", body: JSON.stringify({ values }) });

// ---------- v1.2.0 插件仪表盘卡片（dashboard.view） ----------
export type DashboardCardData =
  | { type: "stats"; items: Array<{ label: string; value: string | number }> }
  | { type: "list"; columns: string[]; rows: Array<Array<string | number>> }
  | { type: "text"; text: string };
export interface DashboardCard {
  id: string;
  plugin: string;
  title: string;
  data: DashboardCardData;
}
export const getDashboardCards = () => call<{ cards: DashboardCard[] }>("/admin/dashboard/cards");

// ---------- M6-α 应用市场（plugin.manage） ----------
export interface MarketEntryRow {
  name: string;
  version: string;
  description: string;
  sha256: string;
  size: number;
  date: string;
  paid?: boolean; // β：付费插件（安装需 license）
}
export interface MarketView {
  available: boolean;
  index: MarketEntryRow[];
  installed: Array<{ name: string; version: string; installedAt: number }>;
  upgradable: Array<{ name: string; from: string; to: string }>;
  localVersions?: Record<string, string[]>;
}
export const getMarket = () => call<MarketView>("/admin/market");
export const marketInstall = (name: string, version?: string) =>
  call<{ msg: string }>(`/admin/market/install`, { method: "POST", body: JSON.stringify({ name, version }) });
export const marketRollback = (name: string, version: string) =>
  call<{ msg: string }>(`/admin/market/rollback`, { method: "POST", body: JSON.stringify({ name, version }) });
export const marketUninstall = (name: string) =>
  call<{ msg: string }>(`/admin/market/uninstall`, { method: "POST", body: JSON.stringify({ name }) });
export const importMarketLicense = (name: string, content: string) =>
  call<{ msg: string }>(`/admin/market/license`, { method: "POST", body: JSON.stringify({ name, content }) });
