/**
 * 分店解析器（ADR-010 R2：自 station 域提升至 kernel——kernel 模板选择链需要
 * Host 兜底解析，纯 DB 查询无路由依赖；station 域 re-export 保持兼容）。
 */
import type { Pool } from "pg";

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

/** Hono 上下文全局变量表（kernel 级：station 中间件注入，各域可读）。 */
declare module "hono" {
  interface ContextVariableMap {
    station: StationContext | null;
    rewritePath: string | undefined;
  }
}

async function findByDomain(pool: Pool, host: string): Promise<StationContext | null> {
  const hostname = (host.split(":")[0] ?? "").toLowerCase().trim();
  if (!hostname || hostname.length > 100) return null;
  const r = await pool.query(
    `SELECT id, user_id, level_id, status, slug, name, title, logo, favicon, site_subtitle, site_description,
            roll_notice, home_notice, footer_info, master_sort, master_goods
     FROM gq_station
     WHERE (lower(domain) = $1 OR lower(domain_2) = $1)
       AND status = 1 AND delete_time IS NULL LIMIT 1`,
    [hostname],
  );
  return (r.rows[0] as StationContext) ?? null;
}

async function findBySlug(pool: Pool, slug: string): Promise<StationContext | null> {
  const s = slug.toLowerCase().slice(0, 50);
  const r = await pool.query(
    `SELECT id, user_id, level_id, status, slug, name, title, logo, favicon, site_subtitle, site_description,
            roll_notice, home_notice, footer_info, master_sort, master_goods
     FROM gq_station
     WHERE lower(slug) = $1 AND status = 1 AND delete_time IS NULL LIMIT 1`,
    [s],
  );
  return (r.rows[0] as StationContext) ?? null;
}

/** 解析分店上下文：Host 域名 > /s/{slug} 路径（含 rewrite）> cookie 兜底。 */
export async function resolveStation(
  pool: Pool,
  req: { host: string | undefined; path: string; cookieSlug: string | undefined; slugMode: boolean },
): Promise<{ station: StationContext | null; rewritePath?: string }> {
  if (req.host) {
    const byDomain = await findByDomain(pool, req.host);
    if (byDomain) return { station: byDomain };
  }
  const m = req.path.match(/^\/s\/([A-Za-z0-9_-]{1,50})(\/.*)?$/);
  if (m && req.slugMode && m[1]) {
    const st = await findBySlug(pool, m[1]);
    if (st) {
      return { station: st, rewritePath: m[2] ?? "/" };
    }
  }
  if (req.cookieSlug) {
    const st = await findBySlug(pool, req.cookieSlug);
    if (st) return { station: st };
  }
  return { station: null };
}
