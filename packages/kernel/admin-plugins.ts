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

import type { AppEnv } from "./app-env.js";
import { adminPermGuard } from "./admin-auth.js";
import { BUILTIN_PLUGINS, listGoodsTypes, listPayPlugins, pluginOverview } from "./plugin-host.js";
import {
  installPlugin, rollbackPlugin, uninstallPlugin, marketView, marketSourceFromEnv, localVersions,
} from "./plugin-market.js";

export const adminPluginRoutes = new Hono<AppEnv>();

adminPluginRoutes.get("/v1/admin/plugins", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const ov = pluginOverview();
  return c.json({
    code: 0,
    data: {
      builtin: BUILTIN_PLUGINS.map((p) => ({ name: p.name, version: p.version, description: p.description ?? "" })),
      activated: ov.activated,
      goods_types: listGoodsTypes().map((g) => ({ type: g.type, label: g.label, plugin: g.plugin })),
      pay_plugins: listPayPlugins().map((p) => ({ name: p.name, label: p.label, kind: p.kind, plugin: p.plugin })),
      note: "启停写 active_plugins 后需重启 core 生效（不热加载，ADR-008 S1）",
    },
  });
});

adminPluginRoutes.post("/v1/admin/plugins/:name/toggle", async (c) => {
  const denied = await adminPermGuard(c, "plugin.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const name = String(c.req.param("name") ?? "").slice(0, 50);
  const def = BUILTIN_PLUGINS.find((p) => p.name === name);
  if (!def) return c.json({ code: 404, msg: "plugin not builtin" }, 404);
  const ov = pluginOverview();
  const isOn = ov.activated.includes(name);
  // 计算新 active_plugins：明确全名单（避免"不存在=全开"语义歧义）
  const allNames = BUILTIN_PLUGINS.map((p) => p.name);
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
