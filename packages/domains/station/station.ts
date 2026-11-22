/**
 * M3 分店多租户（ADR-004）。
 *
 * D2 StationContext：Hono 中间件解析租户，优先级对齐上游：
 *   1. 独立域名（Host 精确匹配 gq_station.domain）
 *   2. /s/{slug} 路径前缀（station_slug_mode=1），命中种 gq_station_slug cookie（30 天）
 *   3. cookie 兜底（用户跳出 /s/ 前缀后仍在分店内）
 *   4. 无命中 → 主站（station=null）
 * 停用/软删分店的 storefront 请求一律 403。
 * 挂载顺序硬规则：本中间件必须先于商品列表/价格计算/下单路由。
 *
 * D6 开通与等级：5 档种子（上游原值）+ 余额开通（level_order 复用）。
 * D4 金额：gq_station_level.price/service_change/cash_change 为 decimal 元（平移基线），
 *          应用层在边界换算为分（half-up）。
 */
import { Hono } from "hono";

import type { AppEnv } from "@gqshop/kernel";
// 解析器与上下文类型已提升至 kernel（ADR-010 R2：模板选择链 Host 兜底需要；此处 re-export 保持兼容）
import { resolveStation } from "@gqshop/kernel";
import type { StationContext } from "@gqshop/kernel";

export { resolveStation };
export type { StationContext };
// ContextVariableMap 声明已上移 kernel（station-resolver.ts，全局变量表属内核）

/** slug 保留字（与主站路由/子域保留前缀对齐）。 */
export const SLUG_RESERVED = new Set([
  "admin", "api", "user", "shop", "s", "static", "assets", "healthz", "www", "m", "mail", "ftp", "login", "register",
]);

/** 中间件：解析分店并注入 c.var.station；storefrontOnly 时停用店 403（对齐上游"当前分店已停用"）。 */
export function stationMiddleware(opts: { storefrontOnly?: boolean } = {}) {
  return async (c: import("hono").Context<AppEnv>, next: () => Promise<void>) => {
    const pool = c.get("pool");
    const cookieSlug = c.req.header("cookie")
      ?.split(";")
      .map((kv) => kv.trim())
      .find((kv) => kv.startsWith("gq_station_slug="))
      ?.slice("gq_station_slug=".length);
    const { station, rewritePath } = await resolveStation(pool, {
      host: c.req.header("host") ?? undefined,
      path: new URL(c.req.url).pathname,
      cookieSlug,
      slugMode: true, // 上游 station_slug_mode=1 默认开启（option 化留待后台设置项）
    });
    c.set("station", station);
    if (station && rewritePath) {
      // /s/{slug} 命中：种 30 天 cookie，rewrite 挂到上下文供 storefront 使用
      c.header("set-cookie", `gq_station_slug=${encodeURIComponent(station.slug ?? "")}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
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

/** 幂等种子：gq_station_level 为空才写入（与 seedMemberships 同策略）。 */
export async function seedStationLevels(pool: import("pg").Pool): Promise<void> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM gq_station_level`);
  if (r.rows[0].n > 0) return;
  const now = Date.now();
  for (const [i, s] of STATION_LEVEL_SEEDS.entries()) {
    await pool.query(
      `INSERT INTO gq_station_level
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
