/**
 * M5-γ 插件管理（ADR-008 P1，权限位 plugin.manage）：
 *   GET   /v1/admin/plugins             — 内置清单 + 激活态 + 各注册表贡献
 *   POST  /v1/admin/plugins/:name/toggle — 改 dc_options.active_plugins（JSON 数组；
 *                                          不存在=全开。toggle 后需重启 core 生效——S1 不热加载）
 */
import { Hono } from "hono";

import type { AppEnv } from "./index.js";
import { adminPermGuard } from "./lib/admin-auth.js";
import { BUILTIN_PLUGINS, listGoodsTypes, listPayPlugins, pluginOverview } from "./lib/plugin-host.js";

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
    `INSERT INTO dc_options (option_name, option_value) VALUES ('active_plugins', $1)
     ON CONFLICT (option_name) DO UPDATE SET option_value = $1`,
    [JSON.stringify(next)],
  );
  return c.json({
    code: 0,
    msg: `已${isOn ? "停用" : "启用"} ${name}，重启 core 后生效`,
    data: { active_plugins: next },
  });
});
