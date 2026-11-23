/**
 * M5-α admin 权限组与会话票（ADR-008 A1）：
 *   - admin JWT 会话票（scope="admin"，8h）替代登录接口下发全局 GQSHOP_ADMIN_KEY（审计 M3 收口）
 *   - v1.1.1：X-Admin-Key 机器通道兼容期结束，GQSHOP_ADMIN_KEY_CHANNEL 开关删除，会话票唯一
 *   - 权限模型：gq_admin_group.menu_permissions JSON { menus:[], perms:["域.动作"|"*"] }
 *     旁路：system_founder_uid option（对齐上游）与 admin_group_id=0（未分组=超管，兼容存量 founder）
 *   - 权限位命名 域.动作：dashboard.view goods.manage stock.manage order.view order.ship
 *     physical.manage blog.manage blog.moderate aftersale.manage user.withdraw
 *     user.recharge station.manage group.manage template.manage plugin.manage
 */
import type { Context } from "hono";
import { sign, verify } from "hono/jwt";
import type { Pool } from "pg";

const ADMIN_TOKEN_TTL_SEC = 8 * 60 * 60; // 8h 工作会话

export interface AdminTokenPayload {
  uid: number;
  groupId: number;
  username?: string;
  scope: "admin";
  exp: number;
}

export type AdminAuth = { via: "jwt"; uid: number; groupId: number };

export async function signAdminToken(
  secret: string,
  uid: number,
  groupId: number,
  username = "",
): Promise<string> {
  return await sign(
    { uid, groupId, username, scope: "admin", exp: Math.floor(Date.now() / 1000) + ADMIN_TOKEN_TTL_SEC },
    secret,
    "HS256",
  );
}

export async function verifyAdminToken(secret: string, token: string): Promise<AdminTokenPayload | null> {
  try {
    const p = (await verify(token, secret, "HS256")) as unknown as AdminTokenPayload;
    if (p.scope !== "admin" || !p.uid || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

/** 认证所需的最小 Variables 约束（AppEnv 等超集均兼容）。 */
interface AuthEnv {
  Variables: {
    pool: import("pg").Pool;
    jwtSecret: string;
    adminAuth?: AdminAuth;
  };
}

/** 全局认证兜底（挂 /v1/admin/*，漏挂权限位的路由也不会裸奔）。通过写 adminAuth 供权限检查复用。
 *  v1.1.1：X-Admin-Key 机器通道已删除，仅认 admin 会话票（Bearer JWT）。 */
export function requireAdminAuth() {
  return async <E extends AuthEnv>(c: Context<E>, next: () => Promise<void>) => {
    const auth = c.req.header("Authorization");
    if (auth?.startsWith("Bearer ")) {
      const payload = await verifyAdminToken(c.get("jwtSecret"), auth.slice(7));
      if (payload) {
        // 票有效 ≠ 账号仍有效：实时核 role/state（封禁/降权即时生效）
        const pool: import("pg").Pool = c.get("pool");
        const u = await pool.query<{ role: string; state: number }>(
          `SELECT role, state FROM gq_user WHERE uid = $1 AND delete_time IS NULL LIMIT 1`,
          [payload.uid],
        );
        const row = u.rows[0];
        if (row && row.role === "admin" && row.state === 0) {
          c.set("adminAuth", { via: "jwt", uid: payload.uid, groupId: payload.groupId });
          await next();
          return;
        }
      }
    }
    return c.json({ code: 403, msg: "admin auth required (session token)" }, 403);
  };
}

/** 权限位检查（v1.2.0 起导出：仪表盘卡片等注册表按 perm 过滤复用）。 */
export async function hasPerm(pool: Pool, auth: AdminAuth, perm: string): Promise<boolean> {
  // founder 旁路（system_founder_uid option，对齐上游）
  const founder = await pool.query<{ option_value: string | null }>(
    `SELECT option_value FROM gq_options WHERE option_name = 'system_founder_uid' LIMIT 1`,
  );
  if (Number(founder.rows[0]?.option_value) === auth.uid) return true;
  // 未分组（admin_group_id=0）= 超管（兼容 install-cli 创建的 founder admin）
  if (auth.groupId === 0) return true;
  const g = await pool.query<{ menu_permissions: string | null }>(
    `SELECT menu_permissions FROM gq_admin_group WHERE id = $1 LIMIT 1`,
    [auth.groupId],
  );
  const raw = g.rows[0]?.menu_permissions;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { perms?: string[] };
    const perms = Array.isArray(parsed.perms) ? parsed.perms : [];
    return perms.includes("*") || perms.includes(perm);
  } catch {
    return false;
  }
}

/** 路由级权限位检查（handler 首行调用；返回 Response=拒绝，null=通过）。 */
export async function adminPermGuard<E extends AuthEnv>(
  c: Context<E>,
  perm: string,
): Promise<Response | null> {
  let auth = c.get("adminAuth") as AdminAuth | undefined;
  if (!auth) {
    // 挂载于全局兜底之前的历史路由自认证（与 requireAdminAuth 同逻辑）
    const denied = await new Promise<Response | null>((resolve) => {
      requireAdminAuth()(c, async () => resolve(null)).then((r) => {
        if (r) resolve(r);
      });
    });
    if (denied) return denied;
    auth = c.get("adminAuth") as AdminAuth | undefined;
    if (!auth) return c.json({ code: 403, msg: "admin auth required" }, 403);
  }
  const ok = await hasPerm(c.get("pool"), auth, perm);
  if (!ok) return c.json({ code: 403, msg: `permission denied: ${perm}` }, 403);
  return null;
}
