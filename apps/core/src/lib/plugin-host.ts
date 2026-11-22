/**
 * M5-γ 插件宿主（ADR-008 P1/P2/P3）：
 *   - 启动期加载内置插件（编译期 import 数组），按 dc_options.active_plugins（JSON 数组，
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
const activated = new Map<string, PluginDef>();

export const BUILTIN_PLUGINS: PluginDef[] = [goodsOnce, goodsGeneral, goodsService, payEpay, payBalance];

async function optionGet(pool: Pool, name: string): Promise<string | null> {
  const r = await pool.query<{ option_value: string }>(
    `SELECT option_value FROM dc_options WHERE option_name = $1 LIMIT 1`,
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
  for (const def of BUILTIN_PLUGINS) {
    if (activeNames !== null && !activeNames.includes(def.name)) {
      skipped.push(def.name);
      continue;
    }
    const ctx = {
      bus,
      log: (m: string) => console.log(`[plugin:${def.name}] ${m}`),
      options: {
        get: (n: string) => optionGet(pool, n),
        set: async (n: string, v: string) => {
          await pool.query(
            `INSERT INTO dc_options (option_name, option_value) VALUES ($1, $2)
             ON CONFLICT (option_name) DO UPDATE SET option_value = $2`,
            [n, v],
          );
        },
      },
      registerGoodsType: (entry: GoodsTypeEntry) => goodsTypes.set(entry.type, { plugin: def.name, entry }),
      registerPayPlugin: (entry: PayPluginEntry) => payPlugins.set(entry.name, { plugin: def.name, entry }),
      query: executorOf(pool),
    };
    await def.activate(ctx);
    activated.set(def.name, { ...def, _ctx: ctx } as PluginDef);
    loaded.push(def.name);
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
