/**
 * M5-γ 插件管理 + M6-α 应用市场（权限位 plugin.manage）：
 *   GET   /v1/admin/plugins             — 内置清单 + 激活态 + 各注册表贡献
 *   POST  /v1/admin/plugins/:name/toggle — 启停（重启生效）
 *   GET   /v1/admin/market              — 市场清单+已装+可升级+本地版本（回滚候选）
 *   POST  /v1/admin/market/install      — 安装/升级 {name, version?}
 *   POST  /v1/admin/market/rollback     — 回滚 {name, version}
 *   POST  /v1/admin/market/uninstall    — 卸载 {name}
 */
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppEnv } from "./app-env.js";
import { adminPermGuard } from "./admin-auth.js";
import { BUILTIN_PLUGINS, listGoodsTypes, listPayPlugins, pluginOverview, activatedDef, externalActivatedPlugins } from "./plugin-host.js";
import {
  installPlugin, rollbackPlugin, uninstallPlugin, marketView, marketSourceFromEnv, localVersions,
  licensesDir, requirePluginLicense, listInstalled,
} from "./plugin-market.js";

export const adminPluginRoutes = new Hono<AppEnv>();

adminPluginRoutes.get("/v1/admin/plugins", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const ov = pluginOverview();
  return c.json({
    code: 0,
    data: {
      builtin: BUILTIN_PLUGINS.map((p) => ({
        name: p.name,
        version: p.version,
        description: p.description ?? "",
        has_config: (p.configSchema?.length ?? 0) > 0,
      })),
      external: externalActivatedPlugins().map((p) => ({
        name: p.name,
        version: p.version,
        description: p.description ?? "",
        has_config: (p.configSchema?.length ?? 0) > 0,
      })),
      activated: ov.activated,
      goods_types: listGoodsTypes().map((g) => ({ type: g.type, label: g.label, plugin: g.plugin })),
      pay_plugins: listPayPlugins().map((p) => ({ name: p.name, label: p.label, kind: p.kind, plugin: p.plugin })),
      note: "启停写 active_plugins 后需重启 core 生效（不热加载，ADR-008 S1）",
    },
  });
});

// ============ v1.2.0 插件配置（JSON blob 存 gq_options，键 plugin_config:{name}） ============

const CONFIG_MAX_BYTES = 8 * 1024;

function configOptionName(name: string): string {
  return `plugin_config:${name}`;
}

adminPluginRoutes.get("/v1/admin/plugins/:name/config", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const name = String(c.req.param("name") ?? "").slice(0, 50);
  // 内置或已激活（含市场外部）插件均可配置——市场插件 configSchema 自 v1.3.x 起可配
  const def = BUILTIN_PLUGINS.find((p) => p.name === name) ?? activatedDef(name);
  if (!def) return c.json({ code: 404, msg: "plugin not found (未激活或不存在)" }, 404);
  const r = await c.get("pool").query<{ option_value: string }>(
    `SELECT option_value FROM gq_options WHERE option_name = $1 LIMIT 1`,
    [configOptionName(name)],
  );
  let values: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.rows[0]?.option_value ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = parsed as Record<string, unknown>;
  } catch {
    // 损坏配置按空处理（下次保存即修复）
  }
  return c.json({ code: 0, data: { schema: def.configSchema ?? [], values } });
});

adminPluginRoutes.put("/v1/admin/plugins/:name/config", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const name = String(c.req.param("name") ?? "").slice(0, 50);
  const def = BUILTIN_PLUGINS.find((p) => p.name === name) ?? activatedDef(name);
  if (!def) return c.json({ code: 404, msg: "plugin not found (未激活或不存在)" }, 404);
  const schema = def.configSchema ?? [];
  if (schema.length === 0) return c.json({ code: 400, msg: "该插件未声明配置项" }, 400);
  const body = (await c.req.json().catch(() => null)) as { values?: Record<string, unknown> } | null;
  const input = body?.values;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return c.json({ code: 400, msg: "values (object) required" }, 400);
  }
  // 白名单收敛 + 类型强制：schema 之外的键丢弃，类型不符拒绝（防配置注入）
  const out: Record<string, string | number | boolean> = {};
  for (const f of schema) {
    const v = input[f.key];
    if (v === undefined || v === null || v === "") continue;
    if (f.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return c.json({ code: 400, msg: `${f.key} 须为数字` }, 400);
      out[f.key] = n;
    } else if (f.type === "boolean") {
      out[f.key] = v === true || v === "true" || v === 1 || v === "1";
    } else {
      const s = String(v).slice(0, 500);
      if (s.length === 0) continue;
      out[f.key] = s;
    }
  }
  const blob = JSON.stringify(out);
  if (blob.length > CONFIG_MAX_BYTES) return c.json({ code: 400, msg: "配置过大" }, 400);
  await c.get("pool").query(
    `INSERT INTO gq_options (option_name, option_value) VALUES ($1, $2)
     ON CONFLICT (option_name) DO UPDATE SET option_value = $2`,
    [configOptionName(name), blob],
  );
  return c.json({ code: 0, msg: "已保存（事件触发时即读即用，无需重启）", data: { values: out } });
});

adminPluginRoutes.post("/v1/admin/plugins/:name/toggle", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const name = String(c.req.param("name") ?? "").slice(0, 50);
  // 内置或市场已装（installed.json 指针）插件均可启停
  const installedNames = listInstalled().map((r) => r.name);
  const known = BUILTIN_PLUGINS.some((p) => p.name === name) || installedNames.includes(name);
  if (!known) return c.json({ code: 404, msg: "plugin not found (非内置且未安装)" }, 404);
  const ov = pluginOverview();
  const isOn = ov.activated.includes(name);
  // 计算新 active_plugins：明确全名单=内置+已装外部（避免"不存在=全开"歧义与外部插件被窄化挤掉）
  const allNames = [...new Set([...BUILTIN_PLUGINS.map((p) => p.name), ...installedNames])];
  const next = isOn ? allNames.filter((n) => n !== name) : [...allNames, name];
  await pool.query(
    `INSERT INTO gq_options (option_name, option_value) VALUES ('active_plugins', $1)
     ON CONFLICT (option_name) DO UPDATE SET option_value = $1`,
    [JSON.stringify(next)],
  );
  return c.json({
    code: 0,
    msg: `已${isOn ? "停用" : "启用"} ${name}，重启 core 后生效`,
    data: { active_plugins: next },
  });
});

// ============ M6-α 应用市场 ============

adminPluginRoutes.get("/v1/admin/market", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const source = marketSourceFromEnv();
  if (!source) {
    return c.json({ code: 0, data: { available: false, index: [], installed: [], upgradable: [], localVersions: {} } });
  }
  try {
    const view = await marketView(source);
    const lv: Record<string, string[]> = {};
    for (const rec of view.installed) lv[rec.name] = localVersions(rec.name);
    return c.json({ code: 0, data: { available: true, ...view, localVersions: lv } });
  } catch (err) {
    return c.json({ code: 502, msg: `市场源不可达: ${String(err).slice(0, 120)}` }, 502);
  }
});

adminPluginRoutes.post("/v1/admin/market/install", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const source = marketSourceFromEnv();
  if (!source) return c.json({ code: 400, msg: "市场源未配置（GQSHOP_MARKET_DIR/URL）" }, 400);
  const body = (await c.req.json().catch(() => null)) as { name?: string; version?: string } | null;
  const name = String(body?.name ?? "").trim().slice(0, 50);
  if (!name) return c.json({ code: 400, msg: "name required" }, 400);
  try {
    const r = await installPlugin(c.get("pool"), source, name, body?.version);
    return c.json({ code: 0, msg: `已安装 ${r.name}@${r.version}，重启 core 后生效`, data: r });
  } catch (err) {
    return c.json({ code: 400, msg: `安装失败: ${String((err as Error).message).slice(0, 200)}` }, 400);
  }
});

adminPluginRoutes.post("/v1/admin/market/rollback", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => null)) as { name?: string; version?: string } | null;
  const name = String(body?.name ?? "").trim().slice(0, 50);
  const version = String(body?.version ?? "").trim().slice(0, 30);
  if (!name || !version) return c.json({ code: 400, msg: "name/version required" }, 400);
  try {
    const r = await rollbackPlugin(name, version);
    return c.json({ code: 0, msg: `已回滚 ${name}@${version}，重启 core 后生效`, data: r });
  } catch (err) {
    return c.json({ code: 400, msg: String((err as Error).message).slice(0, 200) }, 400);
  }
});

adminPluginRoutes.post("/v1/admin/market/uninstall", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  const name = String(body?.name ?? "").trim().slice(0, 50);
  if (!name) return c.json({ code: 400, msg: "name required" }, 400);
  await uninstallPlugin(c.get("pool"), name);
  return c.json({ code: 0, msg: `已卸载 ${name}，重启 core 后生效` });
});

// ============ β：付费插件 license 导入（ADR-012 A4；写入前完整复验） ============

adminPluginRoutes.get("/v1/admin/market/licenses", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const dir = licensesDir();
  const list: Array<{ file: string }> = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".lic")) list.push({ file: f });
    }
  }
  return c.json({ code: 0, data: { dir, licenses: list } });
});

adminPluginRoutes.post("/v1/admin/market/license", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => null)) as { name?: string; content?: string } | null;
  const name = String(body?.name ?? "").replace(/[^a-z0-9_]/g, "");
  const content = String(body?.content ?? "");
  if (!name || content.length < 10 || content.length > 8192) {
    return c.json({ code: 400, msg: "name/content 不合法" }, 400);
  }
  // 写入后立即全量复验（验签+域名匹配+覆盖关系）；失败即删（不留坏文件）
  const dir = licensesDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${name}.lic`);
  writeFileSync(target, content, "utf8");
  const check = requirePluginLicense(name);
  if (!check.ok) {
    const { rmSync } = await import("node:fs");
    rmSync(target, { force: true });
    return c.json({ code: 400, msg: `license 校验失败：${check.msg}` }, 400);
  }
  return c.json({ code: 0, msg: `已导入 ${name}.lic（校验通过）` });
});
