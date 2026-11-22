/**
 * GQSHOP core HTTP app.
 *
 * Routes:
 *   GET  /healthz                     — liveness + DB probe
 *   POST /v1/auth/register            — create dc_user row (bcrypt)
 *   POST /v1/auth/login               — verify + JWT
 *   GET  /v1/auth/me                  — JWT-protected profile read
 *   GET  /v1/shop/categories          — goods categories (public)
 *   GET  /v1/shop/goods               — goods list (public, paged)
 *   GET  /v1/shop/goods/:id           — goods detail + SKUs (public)
 *   POST /v1/shop/orders              — create order (guest ok, idempotent, stock reserve)
 *   GET  /v1/shop/orders/:no          — order query + delivered contents
 *   POST /v1/shop/orders/:no/pay-balance — balance pay (JWT, atomic deduct)
 *   ALL  /v1/pay/notify/epay          — epay gateway callback (MD5 verify + log)
 *   POST /v1/pay/mock/confirm         — mock gateway (staging only, admin key)
 *   POST /v1/admin/goods              — create goods + default SKU (admin key)
 *   POST /v1/admin/goods/:id/skus     — add SKUs (admin key)
 *   POST /v1/admin/stock/import       — import cards (admin key)
 *   GET  /v1/admin/orders             — order list (admin key)
 *   GET  /v1/shop/memberships         — membership tiers (public)
 *   POST /v1/user/level/purchase      — buy membership with balance (JWT)
 *   POST /v1/user/recharge/redeem     — redeem recharge card (JWT)
 *   GET  /v1/user/balance/logs        — balance ledger (JWT)
 *   GET  /v1/user/invite              — invite info (JWT)
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";

import type { GqshopDb } from "@gqshop/db";

import { authRoutes } from "./auth.js";
import { requireAdminAuth, type AdminAuth } from "./lib/admin-auth.js";
import { goodsRoutes } from "./shop/goods.js";
import { adminTradeRoutes } from "./shop/stock.js";
import { ordersRoutes } from "./shop/orders.js";
import { payRoutes } from "./shop/pay.js";
import { membershipRoutes } from "./memberships.js";
import { walletRoutes } from "./wallet.js";
import { userCenterRoutes } from "./user-center.js";
import { adminUploadRoutes, adminLoginRoutes, readUploadSafe } from "./admin-files.js";
import { adminGroupRoutes } from "./admin-groups.js";
import { adminTemplateRoutes } from "./admin-templates.js";
import { adminPluginRoutes } from "./admin-plugins.js";
import { discountRoutes, aftersaleRoutes } from "./m2-final.js";
import { blogRoutes } from "./blog.js";
import { physicalRoutes } from "./physical.js";
import { seedStationLevels, stationMiddleware } from "./station.js";
import { stationRoutes } from "./station-routes.js";
import { ipRateLimit } from "./lib/rate-limit.js";

export interface AppEnv {
  Variables: {
    db: GqshopDb;
    pool: Pool;
    jwtSecret: string;
    uid?: number;
    adminAuth?: AdminAuth;
  };
}

export function createApp(
  db: GqshopDb,
  jwtSecret: string,
  pool: Pool,
  adminKey: string,
) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("pool", pool);
    c.set("jwtSecret", jwtSecret);
    await next();
  });

  // M3 分店上下文（D2）：必须先于商品/下单路由（挂载顺序硬规则）
  app.use("/v1/shop/*", stationMiddleware());
  app.use("/s/*", stationMiddleware());

  app.get("/healthz", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ok", db: "up", ts: Date.now() });
    } catch (err) {
      return c.json({ status: "degraded", db: "down", error: String(err).slice(0, 200) }, 503);
    }
  });

  // 公开/用户面路由（这些文件里的 /v1/admin/* 端点由各自 adminPermGuard 声明权限位；
  // M5-α 重排：admin 混合文件全部移到全局认证兜底之后，未声明权限位也不会裸奔）
  app.route("/", authRoutes);
  app.route("/", goodsRoutes);
  app.route("/", ordersRoutes);
  app.route("/", payRoutes);

  app.route("/", adminLoginRoutes); // 公开：登录必须在 /v1/admin/* 认证兜底之前（自带限流+锁定）
  // 全局 admin 认证兜底（M5-α）：X-Admin-Key 机器通道 或 admin JWT 会话票；
  // 权限位由各路由 adminPermGuard(perm) 声明检查
  app.use("/v1/admin/*", requireAdminAuth(adminKey));

  app.route("/", membershipRoutes);
  app.route("/", walletRoutes);
  app.route("/", userCenterRoutes);
  app.route("/", discountRoutes);
  app.route("/", aftersaleRoutes);
  app.route("/", stationRoutes);
  app.route("/", physicalRoutes);
  app.route("/", blogRoutes);
  app.route("/", adminGroupRoutes);
  app.route("/", adminTemplateRoutes);
  app.route("/", adminPluginRoutes);
  app.route("/", adminTradeRoutes);
  app.route("/", adminUploadRoutes);

  // uploads 静态服务（admin 上传的封面等）——无条件挂载，目录运行时创建
  app.get("/uploads/*", (c) => {
    const name = c.req.path.replace("/uploads/", "").replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!name || name.startsWith(".")) return c.text("not found", 404);
    const buf = readUploadSafe(name);
    if (!buf) return c.text("not found", 404);
    const ext = name.split(".").pop() ?? "";
    const types: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif",
    };
    return c.body(new Uint8Array(buf), 200, { "content-type": types[ext] ?? "application/octet-stream" });
  });

  return app;
}
