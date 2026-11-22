/**
 * M5-β 模板管理（ADR-008 T1，权限位 template.manage）：
 *   GET  /v1/admin/templates          — 注册表列表 + 当前默认
 *   POST /v1/admin/templates/default  — 设置 gq_options.front_default
 */
import { Hono } from "hono";

import type { AppEnv } from "./app-env.js";
import { adminPermGuard } from "./admin-auth.js";
import { getRegistry } from "./templates.js";

export const adminTemplateRoutes = new Hono<AppEnv>();

adminTemplateRoutes.get("/v1/admin/templates", async (c) => {
  const denied = await adminPermGuard(c, "template.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const reg = getRegistry();
  const fd = await pool.query<{ option_value: string | null }>(
    `SELECT option_value FROM gq_options WHERE option_name = 'front_default' LIMIT 1`,
  );
  const current = fd.rows[0]?.option_value ?? "default";
  const names = reg ? [...reg.templates.keys()] : [];
  return c.json({
    code: 0,
    data: {
      templates: names,
      current,
      templates_root: reg?.root ?? "",
      available: names.length > 0,
    },
  });
});

adminTemplateRoutes.post("/v1/admin/templates/default", async (c) => {
  const denied = await adminPermGuard(c, "template.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  const name = String(body?.name ?? "").trim().slice(0, 50);
  const reg = getRegistry();
  if (!reg || !reg.templates.has(name)) {
    return c.json({ code: 400, msg: `template not registered: ${name}` }, 400);
  }
  await pool.query(
    `INSERT INTO gq_options (option_name, option_value)
     VALUES ('front_default', $1)
     ON CONFLICT (option_name) DO UPDATE SET option_value = $1`,
    [name],
  );
  return c.json({ code: 0, msg: "ok", data: { front_default: name } });
});
