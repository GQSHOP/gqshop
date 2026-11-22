/** 用户中心 API 客户端：JWT 存 localStorage。 */
const TOKEN_KEY = "gqshop-token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
export function hasToken(): boolean {
  return getToken().length > 0;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/v1" + path, {
    headers: { "content-type": "application/json", Authorization: `Bearer ${getToken()}`, ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("NEED_LOGIN");
  }
  const body = (await res.json()) as { code: number; msg: string; data?: T };
  if (body.code !== 0) throw new Error(body.msg || `API ${body.code}`);
  return body.data as T;
}

export interface Profile {
  uid: number;
  username: string;
  email: string;
  level: number;
  money: string;
}
export interface LevelView {
  uid: number;
  level: number;
  level_name: string | null;
  level_icon: string | null;
  level_expire_time: string | null;
}
export interface Tier {
  id: number;
  name: string;
  icon: string;
  price: string;
  duration_days: number;
  content: string;
  is_default: number;
}
export interface Ledger {
  plus: string;
  money: string;
  description: string;
  create_time: number;
}
export interface InviteInfo {
  invite_code: string;
  invite_url: string;
  direct_count: number;
  direct_list: Array<{ uid: number; username: string; create_time: number }>;
  commission_total: string;
}
export interface UserOrder {
  out_trade_no: string;
  amount: number;
  pay_status: number;
  status: number;
  payment: string | null;
  create_time: string;
}
export interface WithdrawRow {
  id: number;
  amount: string;
  method: string;
  status: number;
  handle_remark: string | null;
}

export const login = (username: string, password: string) =>
  call<{ token: string; uid: number; username: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
export const register = (username: string, password: string, invite?: string) =>
  call<{ uid: number; username: string; invite_code: string }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password, invite }),
  });
export const getMe = () => call<Profile>("/auth/me");
export const getLevel = () => call<LevelView>("/user/level");
export const getTiers = () => call<Tier[]>("/shop/memberships");
export const buyLevel = (levelId: number) =>
  call<{ level_name: string }>("/user/level/purchase", { method: "POST", body: JSON.stringify({ level_id: levelId }) });
export const getLedger = (page = 1) =>
  call<{ list: Ledger[]; balance: string; page: number }>(`/user/balance/logs?page=${page}`);
export const redeemCard = (card_key: string) =>
  call<{ amount: string; balance: string }>("/user/recharge/redeem", { method: "POST", body: JSON.stringify({ card_key }) });
export const getInvite = () => call<InviteInfo>("/user/invite");
export const getUserOrders = (page = 1) =>
  call<{ list: UserOrder[]; page: number }>(`/user/orders?page=${page}`);
export interface AftersaleRow {
  id: number;
  out_trade_no: string;
  goods_title: string;
  type: string;
  reason: string;
  status: number;
  create_time: number;
}
export const getAftersales = () => call<AftersaleRow[]>("/user/aftersale");
export const createAftersale = (body: {
  out_trade_no: string;
  type: string;
  reason: string;
  contact?: string;
}) => call<{ aftersale_id: number }>("/user/aftersale", { method: "POST", body: JSON.stringify(body) });
export interface StationLevel {
  id: number;
  name: string;
  icon: string;
  price: string;
  description: string;
  service_change: string | null;
  cash_change: string | null;
  is_domain: string | null;
  perm_setprice: string | null;
}
export interface MyStation {
  id: number;
  slug: string;
  name: string | null;
  title: string | null;
  status: number;
  domain: string | null;
  level_name: string | null;
  service_change: string | null;
  cash_change: string | null;
  perm_setprice: string | null;
  perm_goodsstate: string | null;
  perm_config: string | null;
  perm_deposit: string | null;
  is_domain: string | null;
  roll_notice: string | null;
  home_notice: string | null;
  income_total: string;
}
export const getStationLevels = () => call<StationLevel[]>("/shop/station-levels");
export const getMyStation = () => call<MyStation>("/user/station");
export const openStation = (body: { level_id: number; slug?: string; name?: string; title?: string }) =>
  call<{ station_id: number; slug: string; out_trade_no: string }>("/user/station/open", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateStationProfile = (body: Record<string, string>) =>
  call<unknown>("/user/station/profile", { method: "PATCH", body: JSON.stringify(body) });
export const bindStationDomain = (domain: string) =>
  call<{ domain: string }>("/user/station/domain", { method: "POST", body: JSON.stringify({ domain }) });
export interface StationTemplateView {
  current: string;
  can_pick: boolean;
  templates: string[];
}
export const getStationTemplate = () => call<StationTemplateView>("/user/station/template");
export const setStationTemplate = (template: string) =>
  call<{ template: string }>("/user/station/template", { method: "POST", body: JSON.stringify({ template }) });
export interface Address {
  id: number;
  receiver_name: string;
  receiver_phone: string;
  region: string;
  address: string;
  buyer_remark: string;
}
export const getAddress = () => call<Address | null>("/user/address");
export const saveAddress = (body: { receiver_name: string; receiver_phone: string; region: string; address: string; buyer_remark?: string }) =>
  call<unknown>("/user/address", { method: "PUT", body: JSON.stringify(body) });
export const requestWithdraw = (amount_yuan: number, method: string, account: string, realname: string) =>
  call<{ withdraw_id: number }>("/user/withdraw", {
    method: "POST",
    body: JSON.stringify({ amount_yuan, method, account, realname }),
  });
export const getWithdraws = () => call<WithdrawRow[]>("/user/withdraw");
