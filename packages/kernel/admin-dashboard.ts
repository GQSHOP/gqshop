/**
 * v1.2.0 插件仪表盘卡片聚合端点（权限位 dashboard.view）：
 *   GET /v1/admin/dashboard/cards — 遍历插件注册卡片，逐卡 load 并过滤额外权限位；
 *   单卡 load 失败跳过（不阻断整页），卡片无缓存（每次请求现查，数据新鲜）。
 */
import { Hono } from "hono";

import type { AppEnv } from "./app-env.js";
import { adminPermGuard, hasPerm } from "./admin-auth.js";
import { executorOf, listDashboardCards } from "./plugin-host.js";
import type { DashboardCardData } from "@gqshop/plugin-api";

export const adminDashboardRoutes = new Hono<AppEnv>();

adminDashboardRoutes.get("/v1/admin/dashboard/cards", async (c) => {
  const denied = await adminPermGuard(c, "dashboard.view");
  if (denied) return denied;
  const pool = c.get("pool");
  const auth = c.get("adminAuth");
  const query = executorOf(pool);
  const out: Array<{ id: string; plugin: string; title: string; data: DashboardCardData }> = [];
  for (const card of listDashboardCards()) {
    if (card.perm && card.perm !== "dashboard.view") {
      if (!auth || !(await hasPerm(pool, auth, card.perm))) continue;
    }
    try {
      const data = await card.load(query);
      out.push({ id: card.id, plugin: card.plugin, title: card.title, data });
    } catch (err) {
      console.error(`[dashboard] 卡片加载失败 ${card.plugin}:${card.id}: ${String(err).slice(0, 150)}`);
    }
  }
  return c.json({ code: 0, data: { cards: out } });
});
