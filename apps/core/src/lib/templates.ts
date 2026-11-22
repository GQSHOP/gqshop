/**
 * M5-β 模板注册表与选择链（ADR-008 T1）。
 * 目录约定：GQSHOP_TEMPLATES_ROOT（默认 /repo/templates）下 {name}/dist/index.html 即注册。
 * 选择链（每请求解析，站点级缓存禁用——选项可热改）：
 *   分店 station_plugin 指定 > dc_options.front_default > "default"
 * 兜底：选择链失效或 TEMPLATES_ROOT 未配置时回落 GQSHOP_STATIC_DIR（旧单模板模式）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "hono";
import type { Pool } from "pg";

export interface TemplateRegistry {
  root: string;
  templates: Map<string, string>; // name -> dist 绝对路径
}

let registry: TemplateRegistry | null = null;

/** 启动时扫描注册（幂等，可重扫）。无目录返回 null（走旧 STATIC_DIR 兜底）。 */
export function scanTemplates(): TemplateRegistry | null {
  const root = process.env.GQSHOP_TEMPLATES_ROOT ?? "/repo/templates";
  if (!existsSync(root)) return null;
  const templates = new Map<string, string>();
  // 同步目录扫描（启动/重扫时机，非请求热路径）
  for (const name of readdirSync(root)) {
    const dist = resolve(root, name, "dist");
    if (statSync(resolve(root, name)).isDirectory() && existsSync(join(dist, "index.html"))) {
      templates.set(name, dist);
    }
  }
  if (templates.size === 0) return null;
  registry = { root, templates };
  return registry;
}

export function getRegistry(): TemplateRegistry | null {
  return registry ?? scanTemplates();
}

/** 请求态选择链：station_plugin（分店指定）> front_default（全局默认）> default。 */
export async function resolveTemplate(
  pool: Pool,
  stationId: number | null,
): Promise<{ name: string; dist: string } | null> {
  const reg = getRegistry();
  if (!reg) return null;
  // 1. 分店指定（dc_station_plugin：type='pc' 行的 plugin_name_en=模板名）
  if (stationId) {
    const sp = await pool.query<{ plugin_name_en: string | null }>(
      `SELECT plugin_name_en FROM dc_station_plugin WHERE station_id = $1 AND type = 'pc' AND pc_switch = 'y' LIMIT 1`,
      [stationId],
    );
    const wanted = sp.rows[0]?.plugin_name_en ?? "";
    if (wanted && reg.templates.has(wanted)) {
      return { name: wanted, dist: reg.templates.get(wanted)! };
    }
  }
  // 2. 全局默认
  const fd = await pool.query<{ option_value: string | null }>(
    `SELECT option_value FROM dc_options WHERE option_name = 'front_default' LIMIT 1`,
  );
  const def = fd.rows[0]?.option_value ?? "";
  if (def && reg.templates.has(def)) {
    return { name: def, dist: reg.templates.get(def)! };
  }
  // 3. default 兜底
  const fallback = reg.templates.get("default");
  return fallback ? { name: "default", dist: fallback } : null;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", eot: "application/vnd.ms-fontobject",
  map: "application/json", txt: "text/plain; charset=utf-8",
};

/** 受控静态读（路径净化防穿越；dist 前缀约束）。文件缺失返回 null。 */
export function readTemplateFile(distRoot: string, urlPath: string): { buf: Buffer; mime: string } | null {
  const clean = (urlPath.split("?")[0] ?? "").replace(/\\/g, "/").replace(/\.\.+/g, "").replace(/^\/+/, "");
  if (!clean || clean.startsWith(".")) return null;
  const root = resolve(distRoot);
  const full = resolve(root, clean);
  if (!full.startsWith(root)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const ext = clean.split(".").pop()?.toLowerCase() ?? "";
  return { buf: readFileSync(full), mime: MIME[ext] ?? "application/octet-stream" };
}

/** 店面静态中间件：选择链 → 文件/SPA fallback。返回 Response（全部情形）。
 *  station 来源：c.var.station（/s/ 路径与 /v1/shop/* 由 stationMiddleware 种入）或
 *  Host 域名自解析（分店独立域名走根路径时无全局中间件，此处补位）。 */
export async function serveTemplate(c: Context): Promise<Response> {
  const pool = c.get("pool") as Pool;
  let station = (c.get("station") as { id?: number } | null | undefined) ?? null;
  if (!station) {
    const { resolveStation } = await import("../station.js");
    const r = await resolveStation(pool, {
      host: c.req.header("host") ?? undefined,
      path: new URL(c.req.url).pathname,
      cookieSlug: undefined,
      slugMode: false, // 根路径不种 cookie（/s/ 中间件职责）
    });
    station = r.station as unknown as { id?: number } | null;
  }
  const tpl = await resolveTemplate(pool, station?.id ?? null);
  if (!tpl) return c.text("template not found", 500);
  // 根路径与无扩展路径 → SPA index
  const path = new URL(c.req.url).pathname;
  const hit = path === "/" || !path.split("/").pop()?.includes(".")
    ? readTemplateFile(tpl.dist, "index.html")
    : readTemplateFile(tpl.dist, path);
  if (!hit) {
    // SPA fallback（路由刷新场景）
    const idx = readTemplateFile(tpl.dist, "index.html");
    if (!idx) return c.text("template index missing", 500);
    return c.body(new Uint8Array(idx.buf), 200, { "content-type": idx.mime, "cache-control": "no-cache" });
  }
  return c.body(new Uint8Array(hit.buf), 200, { "content-type": hit.mime, "cache-control": "no-cache" });
}
