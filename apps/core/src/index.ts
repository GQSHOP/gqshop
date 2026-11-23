/**
 * GQSHOP core HTTP app（ADR-010 R2 后的薄壳装配层）。
 * 内核与域实现位于 packages/kernel + packages/domains/*；本文件只做路由装配。
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";

import type { GqshopDb } from "@gqshop/db";
import * as kernel from "@gqshop/kernel";
import { registeredPluginRoutes } from "@gqshop/kernel";
import * as trade from "@gqshop/domain-trade";
import * as wallet from "@gqshop/domain-wallet";
import * as station from "@gqshop/domain-station";
import * as content from "@gqshop/domain-content";
import * as members from "@gqshop/domain-members";

type AppEnv = kernel.AppEnv;

export function createApp(db: GqshopDb, jwtSecret: string, pool: import("pg").Pool) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("pool", pool);
    c.set("jwtSecret", jwtSecret);
    await next();
  });

  // 分店上下文（D2）：必须先于商品/下单路由（挂载顺序硬规则）
  app.use("/v1/shop/*", station.stationMiddleware());
  app.use("/s/*", station.stationMiddleware());

  app.get("/healthz", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ok", db: "up", ts: Date.now() });
    } catch (err) {
      return c.json({ status: "degraded", db: "down", error: String(err).slice(0, 200) }, 503);
    }
  });

  // 公开/用户面
  app.route("/", kernel.authRoutes);
  app.route("/", trade.goodsRoutes);
  app.route("/", trade.ordersRoutes);
  app.route("/", trade.payRoutes);

  // 插件自定义路由（M6-γ：支付通道 submit/notify 等，注册期已校验 path）
  for (const r of registeredPluginRoutes()) {
    const handler = r.handler as unknown as (c: { req: unknown; json: (b: unknown, s?: number) => Response; text: (t: string, s?: number) => Response; get: (k: string) => unknown; env: Record<string, string | undefined | object> }) => Promise<Response> | Response;
    if (r.method === "GET") app.get(r.path, (c) => handler(c as never));
    else if (r.method === "POST") app.post(r.path, (c) => handler(c as never));
    else app.all(r.path, (c) => handler(c as never));
  }

  app.route("/", kernel.adminLoginRoutes); // 公开：登录在 admin 认证兜底之前
  app.use("/v1/admin/*", kernel.requireAdminAuth()); // 全局认证兜底（v1.1.1 会话票唯一）

  // 域路由（含各自的 admin 端点，权限位由 adminPermGuard 声明）
  app.route("/", members.membershipRoutes);
  app.route("/", wallet.walletRoutes);
  app.route("/", wallet.userCenterRoutes);
  app.route("/", trade.discountRoutes);
  app.route("/", trade.aftersaleRoutes);
  app.route("/", station.stationRoutes);
  app.route("/", content.physicalRoutes);
  app.route("/", content.blogRoutes);
  app.route("/", kernel.adminGroupRoutes);
  app.route("/", kernel.adminTemplateRoutes);
  app.route("/", kernel.adminPluginRoutes);
  app.route("/", kernel.adminDashboardRoutes);
  app.route("/", trade.adminTradeRoutes);
  app.route("/", kernel.adminUploadRoutes);

  // uploads 静态（admin 上传封面等）——无条件挂载，目录运行时创建
  app.get("/uploads/*", (c) => {
    const name = c.req.path.replace("/uploads/", "").replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!name || name.startsWith(".")) return c.text("not found", 404);
    const buf = kernel.readUploadSafe(name);
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

export type { AppEnv };
