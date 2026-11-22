/**
 * Auth routes (M0): register + login + me, against the 1:1-ported gq_user table.
 *
 * Password policy:
 * - New users: bcrypt (60 chars fits gq_user.password varchar(64)).
 * - Legacy users: md5(32 hex) preserved on import (Phase 8 migration, 附录A10);
 *   login transparently verifies md5 then rehashes to bcrypt. NEW password storage
 *   never uses md5 — it exists here ONLY as a migration-compat verifier.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";

import { userTable } from "@gqshop/db";
import { signToken, verifyToken } from "./jwt.js";
import { ipRateLimit } from "./rate-limit.js";
import type { AppEnv } from "./app-env.js";

/**
 * Legacy verifier for legacy md5 passwords — migration compat ONLY (附录A10).
 * New passwords are always bcrypt; md5 appears solely to accept imported rows.
 */
function legacyMd5Verify(password: string, stored: string): boolean {
  return createHash("md5").update(password, "utf8").digest("hex") === stored;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/v1/auth/register", ipRateLimit(60_000, 5), async (c) => {
  const db = c.get("db");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ code: 400, msg: "invalid json body" }, 400);
  }
  const { username, password, email, invite } = body as Record<string, unknown>;
  if (typeof username !== "string" || !/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(username)) {
    return c.json({ code: 400, msg: "username must be 2-32 chars (alnum/_/cn)" }, 400);
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 60) {
    return c.json({ code: 400, msg: "password must be 6-60 chars" }, 400);
  }
  const emailStr = typeof email === "string" ? email.slice(0, 60) : "";

  const existing = await db
    .select({ uid: userTable.uid })
    .from(userTable)
    .where(eq(userTable.username, username))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ code: 409, msg: "username already exists" }, 409);
  }

  // 邀请绑定：invite 为上级的邀请码（可空）
  let superiorUid = 0;
  if (typeof invite === "string" && invite.trim().length > 0) {
    const inv = await db
      .select({ uid: userTable.uid })
      .from(userTable)
      .where(eq(userTable.invite_code, invite.trim().toUpperCase().slice(0, 16)))
      .limit(1);
    superiorUid = inv[0]?.uid ?? 0;
  }

  const now = Math.floor(Date.now() / 1000);
  const hash = bcrypt.hashSync(password, 10);
  // 自带邀请码（8 位大写十六进制，冲突重试）
  let myInvite = randomBytes(4).toString("hex").toUpperCase();
  for (let tries = 0; tries < 3; tries++) {
    const dup = await db
      .select({ uid: userTable.uid })
      .from(userTable)
      .where(eq(userTable.invite_code, myInvite))
      .limit(1);
    if (dup.length === 0) break;
    myInvite = randomBytes(4).toString("hex").toUpperCase();
  }

  const inserted = await db
    .insert(userTable)
    .values({
      username,
      password: hash,
      email: emailStr,
      invite_code: myInvite,
      superior: superiorUid,
      create_time: now,
      update_time: now,
      level: 0,
      state: 0,
    })
    .returning({ uid: userTable.uid, username: userTable.username, invite_code: userTable.invite_code });

  const u = inserted[0];
  if (!u) {
    return c.json({ code: 500, msg: "insert returned no row" }, 500);
  }
  return c.json(
    { code: 0, msg: "ok", data: { uid: u.uid, username: u.username, invite_code: u.invite_code, superior: superiorUid } },
    201,
  );
});

authRoutes.post("/v1/auth/login", ipRateLimit(60_000, 10), async (c) => {
  const db = c.get("db");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ code: 400, msg: "invalid json body" }, 400);
  }
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    return c.json({ code: 400, msg: "username/password required" }, 400);
  }

  const rows = await db
    .select()
    .from(userTable)
    .where(eq(userTable.username, username))
    .limit(1);
  const u = rows[0];
  if (!u || u.state !== 0) {
    return c.json({ code: 401, msg: "invalid credentials" }, 401);
  }
  // 管理员账号不走用户中心登录（后台入口：/admin/login），避免双端会话混淆
  if (u.role === "admin") {
    return c.json({ code: 403, msg: "管理员账号请从管理后台登录（/admin）" }, 403);
  }

  const isMd5 = /^[0-9a-f]{32}$/.test(u.password);
  const ok = isMd5 ? legacyMd5Verify(password, u.password) : bcrypt.compareSync(password, u.password);
  if (!ok) {
    return c.json({ code: 401, msg: "invalid credentials" }, 401);
  }
  if (isMd5) {
    const rehash = bcrypt.hashSync(password, 10);
    await db.update(userTable).set({ password: rehash }).where(eq(userTable.uid, u.uid));
  }

  const secret = c.get("jwtSecret");
  const token = await signToken(secret, { uid: u.uid, username: u.username, level: u.level ?? 0 });
  return c.json({
    code: 0,
    msg: "ok",
    data: { token, uid: u.uid, username: u.username, level: u.level ?? 0 },
  });
});

authRoutes.get("/v1/auth/me", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ code: 401, msg: "missing bearer token" }, 401);
  }
  const payload = await verifyToken(c.get("jwtSecret"), auth.slice(7));
  if (!payload) {
    return c.json({ code: 401, msg: "invalid token" }, 401);
  }
  const db = c.get("db");
  const rows = await db
    .select({
      uid: userTable.uid,
      username: userTable.username,
      email: userTable.email,
      level: userTable.level,
      money: userTable.money,
    })
    .from(userTable)
    .where(eq(userTable.uid, payload.uid))
    .limit(1);
  const u = rows[0];
  if (!u) {
    return c.json({ code: 404, msg: "user not found" }, 404);
  }
  return c.json({ code: 0, msg: "ok", data: u });
});
