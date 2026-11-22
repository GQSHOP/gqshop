/**
 * M3 分店多租户（ADR-004）。
 *
 * D2 StationContext：Hono 中间件解析租户，优先级对齐上游：
 *   1. 独立域名（Host 精确匹配 dc_station.domain）
 *   2. /s/{slug} 路径前缀（station_slug_mode=1），命中种 dc_station_slug cookie（30 天）
 *   3. cookie 兜底（用户跳出 /s/ 前缀后仍在分店内）
 *   4. 无命中 → 主站（station=null）
 * 停用/软删分店的 storefront 请求一律 403。
 * 挂载顺序硬规则：本中间件必须先于商品列表/价格计算/下单路由。
 *
 * D6 开通与等级：5 档种子（上游原值）+ 余额开通（level_order 复用）。
 * D4 金额：dc_station_level.price/service_change/cash_change 为 decimal 元（平移基线），
 *          应用层在边界换算为分（half-up）。
 */
import { Hono } from "hono";

import type { AppEnv } from "./index.js";

export interface StationContext {
  id: number;
  user_id: number;
  level_id: number;
  status: number;
  slug: string | null;
  name: string | null;
  title: string | null;
  logo: string | null;
  favicon: string | null;
  site_subtitle: string | null;
  site_description: string | null;
  roll_notice: string | null;
  home_notice: string | null;
  footer_info: string | null;
  master_sort: number | null;
  master_goods: number | null;
}

declare module "hono" {
  interface ContextVariableMap {
    station: StationContext | null;
    rewritePath: string | undefined;
  }
}

/** slug 保留字（与主站路由/子域保留前缀对齐）。 */
export const SLUG_RESERVED = new Set([
  "admin", "api", "user", "shop", "s", "static", "assets", "healthz", "www", "m", "mail", "ftp", "login", "register",
]);

/** Host → 分店（独立域名）。仅信任反代传入的 Host 头；部署文档要求反代强制重写 Host。 */
async function findByDomain(pool: import("pg").Pool, host: string): Promise<StationContext | null> {
  const hostname = (host.split(":")[0] ?? "").toLowerCase().trim();
  if (!hostname || hostname.length > 100) return null;
  const r = await pool.query(
    `SELECT id, user_id, level_id, status, slug, name, title, logo, favicon, site_subtitle, site_description,
            roll_notice, home_notice, footer_info, master_sort, master_goods
     FROM dc_station
     WHERE (lower(domain) = $1 OR lower(domain_2) = $1)
       AND status = 1 AND delete_time IS NULL LIMIT 1`,
    [hostname],
  );
  return (r.rows[0] as StationContext) ?? null;
}

async function findBySlug(pool: import("pg").Pool, slug: string): Promise<StationContext | null> {
  const s = slug.toLowerCase().slice(0, 50);
  const r = await pool.query(
    `SELECT id, user_id, level_id, status, slug, name, title, logo, favicon, site_subtitle, site_description,
            roll_notice, home_notice, footer_info, master_sort, master_goods
     FROM dc_station
     WHERE lower(slug) = $1 AND status = 1 AND delete_time IS NULL LIMIT 1`,
    [s],
  );
  return (r.rows[0] as StationContext) ?? null;
}

/**
 * 解析分店上下文。返回 { station } 与可选 rewrite：'/s/{slug}/x' → '/x'（供 storefront 内部改写）。
 * 停用店也返回（带 disabled 标记由调用方决定 403）——这里查不到停用店，统一按"不存在"处理，
 * 停用店访问独立域名时 findByDomain 的 status=1 过滤会返回 null（主站视图），上游的 403 语义
 * 由 slug 模式显式查询承担。
 */
export async function resolveStation(
  pool: import("pg").Pool,
  req: { host: string | undefined; path: string; cookieSlug: string | undefined; slugMode: boolean },
): Promise<{ station: StationContext | null; rewritePath?: string }> {
  // 1. 独立域名
  if (req.host) {
    const byDomain = await findByDomain(pool, req.host);
    if (byDomain) return { station: byDomain };
  }
  // 2. /s/{slug} 路径
  const m = req.path.match(/^\/s\/([A-Za-z0-9_-]{1,50})(\/.*)?$/);
  if (m && req.slugMode && m[1]) {
    const st = await findBySlug(pool, m[1]);
    if (st) {
      return { station: st, rewritePath: m[2] ?? "/" };
    }
  }
  // 3. cookie 兜底
  if (req.cookieSlug) {
    const st = await findBySlug(pool, req.cookieSlug);
    if (st) return { station: st };
  }
  return { station: null };
}

/** 中间件：解析分店并注入 c.var.station；storefrontOnly 时停用店 403（对齐上游"当前分店已停用"）。 */
export function stationMiddleware(opts: { storefrontOnly?: boolean } = {}) {
  return async (c: import("hono").Context<AppEnv>, next: () => Promise<void>) => {
    const pool = c.get("pool");
    const cookieSlug = c.req.header("cookie")
      ?.split(";")
      .map((kv) => kv.trim())
      .find((kv) => kv.startsWith("dc_station_slug="))
      ?.slice("dc_station_slug=".length);
    const { station, rewritePath } = await resolveStation(pool, {
      host: c.req.header("host") ?? undefined,
      path: new URL(c.req.url).pathname,
      cookieSlug,
      slugMode: true, // 上游 station_slug_mode=1 默认开启（option 化留待后台设置项）
    });
    c.set("station", station);
    if (station && rewritePath) {
      // /s/{slug} 命中：种 30 天 cookie，rewrite 挂到上下文供 storefront 使用
      c.header("set-cookie", `dc_station_slug=${encodeURIComponent(station.slug ?? "")}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
      c.set("rewritePath", rewritePath);
    }
    await next();
  };
}

// ============ D6 等级种子（上游原值：0/29/99/199/399，手续费 10→1%，提现费 20→2%） ============

export const STATION_LEVEL_SEEDS = [
  { name: "基础版", icon: "ri-store-line", price: "0.00", service_change: "10.00", cash_change: "20.00", perm_setprice: "n", perm_goodsstate: "n", perm_tpl: "n", perm_config: "n", perm_deposit: "n", is_station: "y", is_domain: "n", is_goods: "n", member_gate: 0, description: "免费开通，售卖手续费 10%。" },
  { name: "入门版", icon: "ri-store-2-line", price: "29.00", service_change: "8.00", cash_change: "15.00", perm_setprice: "n", perm_goodsstate: "n", perm_tpl: "n", perm_config: "n", perm_deposit: "n", is_station: "y", is_domain: "n", is_goods: "n", member_gate: 0, description: "手续费 8%，提现费 15%。" },
  { name: "标准版", icon: "ri-store-2-fill", price: "99.00", service_change: "5.00", cash_change: "8.00", perm_setprice: "y", perm_goodsstate: "y", perm_tpl: "n", perm_config: "n", perm_deposit: "y", is_station: "y", is_domain: "y", is_goods: "n", member_gate: 0, description: "可改价/上下架/提现，绑独立域名；手续费 5%。" },
  { name: "专业版", icon: "ri-building-2-line", price: "199.00", service_change: "3.00", cash_change: "5.00", perm_setprice: "y", perm_goodsstate: "y", perm_tpl: "y", perm_config: "y", perm_deposit: "y", is_station: "y", is_domain: "y", is_goods: "y", member_gate: 0, description: "全权限位 + 供货；手续费 3%。" },
  { name: "旗舰版", icon: "ri-building-4-fill", price: "399.00", service_change: "1.00", cash_change: "2.00", perm_setprice: "y", perm_goodsstate: "y", perm_tpl: "y", perm_config: "y", perm_deposit: "y", is_station: "y", is_domain: "y", is_goods: "y", member_gate: 0, description: "最低费率 1%/2%，旗舰权益。" },
] as const;

/** 幂等种子：dc_station_level 为空才写入（与 seedMemberships 同策略）。 */
export async function seedStationLevels(pool: import("pg").Pool): Promise<void> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM dc_station_level`);
  if (r.rows[0].n > 0) return;
  const now = Date.now();
  for (const [i, s] of STATION_LEVEL_SEEDS.entries()) {
    await pool.query(
      `INSERT INTO dc_station_level
         (name, icon, icon_image, sort, price, description, member_gate, is_station, is_domain, is_goods,
          perm_setprice, perm_goodsstate, perm_tpl, perm_config, perm_deposit,
          service_change, cash_change, "using", create_time, update_time, upgrade_mode,
          upgrade_sales_amount, upgrade_order_count, upgrade_days, upgrade_sub_count)
       VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'y',$17,$17,'any',0,0,0,0)`,
      [s.name, s.icon, i + 1, s.price, s.description, s.member_gate, s.is_station, s.is_domain, s.is_goods,
        s.perm_setprice, s.perm_goodsstate, s.perm_tpl, s.perm_config, s.perm_deposit,
        s.service_change, s.cash_change, now],
    );
  }
}

/** 元(字符串/number)→分（half-up），D4 边界换算。 */
export function yuanToCentsHalfUp(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Math.round(Number(v) * 100);
}
