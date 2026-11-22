/**
 * M5-α 后台用户组管理（ADR-008 A1，权限位=group.manage）：
 *   GET    /v1/admin/groups        — 组列表（含成员数）
 *   POST   /v1/admin/groups        — 建组（name + perms 数组）
 *   PATCH  /v1/admin/groups/:id    — 改名/改权限位
 *   DELETE /v1/admin/groups/:id    — 删组（组内成员回落 admin_group_id=0=超管，需先移出——v1 拒绝删除非空组）
 *   POST   /v1/admin/groups/:id/members — 成员分配（username → 组）
 * 幂等种子：dc_admin_group 为空时写"超级管理员"全权限组（历史 founder 账号 admin_group_id=0
 * 本就旁路全权限，种子仅保证管理页非空）。
 */
import { Hono } from "hono";

import type { AppEnv } from "./index.js";
import { adminPermGuard } from "./lib/admin-auth.js";

export const adminGroupRoutes = new Hono<AppEnv>();

export const ADMIN_PERMS_ALL = [
  "dashboard.view", "goods.manage", "stock.manage", "order.view", "order.ship",
  "physical.manage", "blog.manage", "blog.moderate", "aftersale.manage",
  "user.withdraw", "user.recharge", "station.manage", "group.manage",
  "template.manage", "plugin.manage",
] as const;

/** 幂等种子：空表写入全权限组（menu_permissions JSON）。时间列=int 秒（勿传毫秒，int4 溢出）。 */
export async function seedAdminGroups(pool: import("pg").Pool): Promise<void> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM dc_admin_group`);
  if (r.rows[0].n > 0) return;
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO dc_admin_group (name, menu_permissions, create_time, update_time)
     VALUES ($1, $2, $3, $3)`,
    ["超级管理员", JSON.stringify({ menus: [], perms: ["*"] }), now],
  );
  console.log("[admin-groups] seeded 超级管理员 (all perms)");
}

adminGroupRoutes.get("/v1/admin/groups", async (c) => {
  const denied = await adminPermGuard(c, "group.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT g.id, g.name, g.menu_permissions,
            (SELECT COUNT(*)::int FROM dc_user u WHERE u.admin_group_id = g.id AND u.role = 'admin' AND u.delete_time IS NULL) AS member_count
     FROM dc_admin_group g ORDER BY g.id ASC LIMIT 100`,
  );
  return c.json({ code: 0, data: { list: r.rows, all_perms: ADMIN_PERMS_ALL } });
});

adminGroupRoutes.post("/v1/admin/groups", async (c) => {
  const denied = await adminPermGuard(c, "group.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { name?: string; perms?: string[] } | null;
  const name = String(body?.name ?? "").trim().slice(0, 60);
  if (!name) return c.json({ code: 400, msg: "name required" }, 400);
  const perms = (Array.isArray(body?.perms) ? body.perms : [])
    .map((p) => String(p))
    .filter((p) => p === "*" || (ADMIN_PERMS_ALL as readonly string[]).includes(p))
    .slice(0, 100);
  const now = Date.now();
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO dc_admin_group (name, menu_permissions, create_time, update_time)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [name, JSON.stringify({ menus: [], perms }), now],
  );
  return c.json({ code: 0, data: { id: ins.rows[0]?.id } }, 201);
});

adminGroupRoutes.patch("/v1/admin/groups/:id", async (c) => {
  const denied = await adminPermGuard(c, "group.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { name?: string; perms?: string[] } | null;
  if (body?.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) return c.json({ code: 400, msg: "name cannot be empty" }, 400);
    await pool.query(`UPDATE dc_admin_group SET name = $2, update_time = $3 WHERE id = $1`, [id, name, Date.now()]);
  }
  if (body?.perms !== undefined) {
    const perms = (Array.isArray(body.perms) ? body.perms : [])
      .map((p) => String(p))
      .filter((p) => p === "*" || (ADMIN_PERMS_ALL as readonly string[]).includes(p))
      .slice(0, 100);
    await pool.query(
      `UPDATE dc_admin_group SET menu_permissions = $2, update_time = $3 WHERE id = $1`,
      [id, JSON.stringify({ menus: [], perms }), Date.now()],
    );
  }
  return c.json({ code: 0, msg: "ok" });
});

adminGroupRoutes.delete("/v1/admin/groups/:id", async (c) => {
  const denied = await adminPermGuard(c, "group.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const members = await pool.query(
    `SELECT COUNT(*)::int AS n FROM dc_user WHERE admin_group_id = $1 AND delete_time IS NULL`,
    [id],
  );
  if (members.rows[0].n > 0) {
    return c.json({ code: 409, msg: "group not empty, move members first" }, 409);
  }
  await pool.query(`DELETE FROM dc_admin_group WHERE id = $1`, [id]);
  return c.json({ code: 0, msg: "deleted" });
});

/** 成员分配：username → 本组（仅 role=admin 账号可入组；groupId=0=移出回超管）。 */
adminGroupRoutes.post("/v1/admin/groups/:id/members", async (c) => {
  const denied = await adminPermGuard(c, "group.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const groupId = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { username?: string; op?: "add" | "remove" } | null;
  const username = String(body?.username ?? "").trim().slice(0, 32);
  const op = body?.op === "remove" ? "remove" : "add";
  if (!username) return c.json({ code: 400, msg: "username required" }, 400);
  if (groupId === 0) return c.json({ code: 400, msg: "cannot target group 0" }, 400);
  const target = groupId; // op=remove 时移出（回落 0=超管语义，调用方慎用）
  const u = await pool.query<{ uid: number; role: string }>(
    `SELECT uid, role FROM dc_user WHERE username = $1 AND delete_time IS NULL LIMIT 1`,
    [username],
  );
  const row = u.rows[0];
  if (!row) return c.json({ code: 404, msg: "user not found" }, 404);
  if (row.role !== "admin") return c.json({ code: 409, msg: "not an admin account" }, 409);
  await pool.query(`UPDATE dc_user SET admin_group_id = $2 WHERE uid = $1`, [row.uid, op === "add" ? target : 0]);
  return c.json({ code: 0, msg: "ok" });
});
