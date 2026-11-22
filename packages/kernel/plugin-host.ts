/**
 * M5-γ 插件宿主（ADR-008 P1/P2/P3）：
 *   - 启动期加载内置插件（编译期 import 数组），按 gq_options.active_plugins（JSON 数组，
 *     不存在=全开，对齐上游 active_plugins 语义）决定 activate 与否
 *   - 注册表：goodsTypes（deliver 分发）/ payPlugins（支付方式清单与下单校验）
 *   - PluginContext 最小 API 面：bus/logger/options/注册器/受控 query（executor 由调用点传入）
 *   - 不热加载：启停（active_plugins 改写）需重启 core（S1 安全条款）
 */
import type { Pool } from "pg";

import {
  PluginBus,
  type GoodsTypeEntry,
  type PayPluginEntry,
  type PluginDef,
  type PluginRoute,
  type QueryExecutor,
} from "@gqshop/plugin-api";
import goodsOnce from "@gqshop/plugin-goods-once";
import goodsGeneral from "@gqshop/plugin-goods-general";
import goodsService from "@gqshop/plugin-goods-service";
import payEpay from "@gqshop/plugin-pay-epay";
import payBalance from "@gqshop/plugin-pay-balance";

export const bus = new PluginBus();
const goodsTypes = new Map<string, { plugin: string; entry: GoodsTypeEntry }>();
const payPlugins = new Map<string, { plugin: string; entry: PayPluginEntry }>();
const pluginRoutes = new Map<string, PluginRoute>(); // key: `${method} ${path}`
const activated = new Map<string, PluginDef>();

export const BUILTIN_PLUGINS: PluginDef[] = [goodsOnce, goodsGeneral, goodsService, payEpay, payBalance];

async function optionGet(pool: Pool, name: string): Promise<string | null> {
  const r = await pool.query<{ option_value: string }>(
    `SELECT option_value FROM gq_options WHERE option_name = $1 LIMIT 1`,
    [name],
  );
  return r.rows[0]?.option_value ?? null;
}

/** 受控执行器包装（仅类型收窄，无额外能力）。 */
function executorOf(pool: Pool): QueryExecutor {
  return {
    query: (async (sql: string, params?: unknown[]) => pool.query(sql, params)) as QueryExecutor["query"],
  };
}

export function getGoodsTypeHandler(type: string): GoodsTypeEntry["deliver"] | null {
  const hit = goodsTypes.get(type);
  return hit ? hit.entry.deliver : null;
}

export function listGoodsTypes(): Array<GoodsTypeEntry & { plugin: string }> {
  return [...goodsTypes.values()].map((h) => ({ ...h.entry, plugin: h.plugin }));
}

export function listPayPlugins(): Array<PayPluginEntry & { plugin: string }> {
  return [...payPlugins.values()].map((h) => ({ ...h.entry, plugin: h.plugin }));
}

export function isValidPayPlugin(name: string): boolean {
  return payPlugins.has(name);
}

/** 启动加载（main.ts 调用，种子后）。返回激活清单供日志与 admin 端点。 */
export async function loadPlugins(pool: Pool): Promise<{ loaded: string[]; skipped: string[] }> {
  const raw = await optionGet(pool, "active_plugins");
  let activeNames: string[] | null = null; // null = 全开
  if (raw) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) activeNames = arr.map(String);
    } catch {
      console.error("[plugins] active_plugins 不可解析，按全开处理");
    }
  }
  const loaded: string[] = [];
  const skipped: string[] = [];
  pluginRoutes.clear(); // 重启即重注册（loadPlugins 幂等）
  const activateOne = async (def: PluginDef) => {
    const ctx = {
      bus,
      log: (m: string) => console.log(`[plugin:${def.name}] ${m}`),
      options: {
        get: (n: string) => optionGet(pool, n),
        set: async (n: string, v: string) => {
          await pool.query(
            `INSERT INTO gq_options (option_name, option_value) VALUES ($1, $2)
             ON CONFLICT (option_name) DO UPDATE SET option_value = $2`,
            [n, v],
          );
        },
      },
      registerGoodsType: (entry: GoodsTypeEntry) => goodsTypes.set(entry.type, { plugin: def.name, entry }),
      registerPayPlugin: (entry: PayPluginEntry) => payPlugins.set(entry.name, { plugin: def.name, entry }),
      registerRoute: (route: PluginRoute) => {
        if (!route.path.startsWith("/")) return;
        pluginRoutes.set(`${route.method} ${route.path}`, { ...route });
      },
      query: executorOf(pool),
    };
    await def.activate(ctx);
    activated.set(def.name, def);
    loaded.push(def.name);
  };
  for (const def of BUILTIN_PLUGINS) {
    if (activeNames !== null && !activeNames.includes(def.name)) {
      skipped.push(def.name);
      continue;
    }
    await activateOne(def);
  }
  // M6-α：市场安装的外部插件（installed.json 指针 → data/plugins/{name}/{version}/index.js）
  const { listInstalled } = await import("./plugin-market.js");
  const { pathToFileURL } = await import("node:url");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const rec of listInstalled()) {
    if (BUILTIN_PLUGINS.some((b) => b.name === rec.name)) continue; // 内置优先
    if (activeNames !== null && !activeNames.includes(rec.name)) {
      skipped.push(rec.name);
      continue;
    }
    const root = process.env.GQSHOP_PLUGINS_DIR ?? "./data/plugins";
    const entry = join(root, rec.name, rec.version, "index.js");
    if (!existsSync(entry)) {
      console.error(`[plugins] 外部插件缺入口: ${rec.name}@${rec.version}`);
      skipped.push(rec.name);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL((await import("node:path")).resolve(entry)).href)) as {
        default?: PluginDef;
      } & PluginDef;
      const def = mod.default ?? mod;
      if (typeof def?.name !== "string" || typeof def?.activate !== "function") {
        throw new Error("插件导出不符合 PluginDef");
      }
      await activateOne(def);
    } catch (err) {
      console.error(`[plugins] 外部插件加载失败 ${rec.name}:`, err);
      skipped.push(rec.name);
    }
  }
  await bus.emit("core:init", {}, (m) => console.error(`[plugin-bus] ${m}`));
  console.log(`[plugins] loaded=[${loaded.join(", ")}] skipped=[${skipped.join(", ")}]`);
  return { loaded, skipped };
}

/** 已注册概览（admin 插件管理页）。 */
export function pluginOverview(): { builtin: string[]; activated: string[] } {
  return {
    builtin: BUILTIN_PLUGINS.map((p) => p.name),
    activated: [...activated.keys()],
  };
}

/** 插件自定义路由（M6-γ：core 装配期挂载）。 */
export function registeredPluginRoutes(): PluginRoute[] {
  return [...pluginRoutes.values()];
}
