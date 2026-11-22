/**
 * 易支付通道插件（M6-γ 完全插件化）：
 * 支付方式清单 + /v1/pay/epay/submit（代取支付页，SSRF 防线）
 * + /v1/pay/notify/epay（MD5 验签回调 + 全量日志）。
 * 结算经 trade 域 settlePayment（生态层→域层单向依赖，ADR-008/010）。
 */
import { definePlugin } from "@gqshop/plugin-api";
import {
  epayConfigFromEnv, publicBaseFromEnv, assertPublicHttpUrl,
  EPAY_TRADE_SUCCESS, epaySign, epayTypeFromPlugin, epayVerify,
  centsToYuan, yuanToCents,
} from "@gqshop/kernel";
import { settlePayment } from "@gqshop/domain-trade";

/** 弱类型 Hono 上下文（插件路由注册面的结构类型；core 装配期挂载）。 */
interface Ctx {
  req: {
    query: (k?: string) => Record<string, string> | string;
    header: (k: string) => string | undefined;
    parseBody: () => Promise<Record<string, string | File>>;
    json: () => Promise<unknown>;
  };
  get: (k: string) => unknown;
  json: (b: unknown, s?: number) => Response;
  text: (t: string, s?: number) => Response;
}

export default definePlugin({
  name: "pay_epay",
  version: "1.1.0",
  description: "易支付通道（支付宝/微信）：submit 代取 + MD5 验签回调（M6-γ 路由完全插件化）",
  activate(ctx) {
    ctx.registerPayPlugin({ name: "epay_ali", label: "支付宝（易支付）", kind: "epay" });
    ctx.registerPayPlugin({ name: "epay_wx", label: "微信（易支付）", kind: "epay" });

    ctx.registerRoute({
      method: "GET",
      path: "/v1/pay/epay/submit",
      handler: async (raw) => {
        const c = raw as unknown as Ctx;
        const cfg = epayConfigFromEnv();
        if (!cfg) return c.json({ code: 501, msg: "epay not configured" }, 501);
        const pool = c.get("pool") as import("pg").Pool;
        const q = c.req.query() as Record<string, string>;
        const no = String(q.out_trade_no ?? "").slice(0, 30);
        if (!no) return c.json({ code: 400, msg: "out_trade_no required" }, 400);

        const o = await pool.query(
          `SELECT out_trade_no, amount, status, pay_plugin FROM gq_order WHERE out_trade_no = $1 AND delete_time IS NULL`,
          [no],
        );
        const order = o.rows[0] as { out_trade_no: string; amount: number; status: number; pay_plugin: string | null } | undefined;
        if (!order) return c.json({ code: 404, msg: "order not found" }, 404);
        if (order.status === 2) return c.json({ code: 409, msg: "order already delivered" }, 409);
        const type = epayTypeFromPlugin(order.pay_plugin);
        if (!type) return c.json({ code: 400, msg: `order pay_plugin ${order.pay_plugin} is not an epay channel` }, 400);

        const base = publicBaseFromEnv();
        const goodsTitle = await pool.query(
          `SELECT g.title FROM gq_order_list ol LEFT JOIN gq_goods g ON g.id = ol.goods_id
           WHERE ol.order_id = (SELECT id FROM gq_order WHERE out_trade_no = $1) LIMIT 1`,
          [no],
        );
        const name = String(goodsTitle.rows[0]?.title ?? "GQSHOP order").slice(0, 100);

        const params: Record<string, string> = {
          pid: cfg.pid,
          type,
          out_trade_no: order.out_trade_no,
          notify_url: `${base}/v1/pay/notify/epay`,
          return_url: `${base}/result/${order.out_trade_no}`,
          name,
          money: centsToYuan(order.amount),
          sitename: "GQSHOP",
        };
        const sign = epaySign(params, cfg.key);
        const qs = new URLSearchParams({ ...params, sign, sign_type: "MD5" }).toString();
        const submitUrl = `${cfg.api}/submit.php?${qs}`;

        // SSRF 防线：公网白名单 + 禁重定向
        const gwTarget = assertPublicHttpUrl(submitUrl);
        const gw = await fetch(gwTarget, { redirect: "error", signal: AbortSignal.timeout(15000) });
        if (!gw.ok) return c.json({ code: 502, msg: `gateway http ${gw.status}` }, 502);
        const gwBody = (await gw.json().catch(() => null)) as
          | { code?: number; msg?: string; payurl?: string; qrcode?: string; trade_no?: string }
          | null;
        if (!gwBody || gwBody.code !== 1 || !gwBody.payurl) {
          return c.json({ code: 502, msg: `gateway rejected: ${gwBody?.msg ?? "no payurl"}` }, 502);
        }
        return c.json({
          code: 0,
          data: { pay_url: gwBody.payurl, qrcode: gwBody.qrcode ?? gwBody.payurl, trade_no: gwBody.trade_no ?? "", type },
        });
      },
    });

    ctx.registerRoute({
      method: "ALL",
      path: "/v1/pay/notify/epay",
      handler: async (raw) => {
        const c = raw as unknown as Ctx;
        const pool = c.get("pool") as import("pg").Pool;
        const key = process.env.GQSHOP_EPAY_KEY ?? "";
        const r2 = c.req.query() as Record<string, string>;
        const raw2: Record<string, string> = {};
        for (const [k, v] of Object.entries(r2)) raw2[k] = String(v);
        const form = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
        for (const [k, v] of Object.entries(form)) {
          if (typeof v === "string") raw2[k] = v;
        }

        await pool.query(
          `INSERT INTO gq_pay_callback_log (gateway, order_no, amount, status, raw_data, ip, create_time)
           VALUES ('epay', $1, $2, $3, $4, $5, $6)`,
          [
            String(raw2.out_trade_no ?? "").slice(0, 64),
            String(raw2.money ?? raw2.total_fee ?? "").slice(0, 32),
            String(raw2.trade_status ?? "").slice(0, 32),
            JSON.stringify(raw2).slice(0, 5000),
            c.req.header("x-forwarded-for") ?? "",
            Math.floor(Date.now() / 1000),
          ],
        );

        if (!key) return c.text("fail");
        if (!epayVerify(raw2, key)) return c.text("fail");
        if (raw2.trade_status !== EPAY_TRADE_SUCCESS) return c.text("success");

        const cents = yuanToCents(raw2.money ?? raw2.total_fee ?? "0");
        const r = await settlePayment(pool, String(raw2.out_trade_no ?? ""), "epay", cents);
        return c.text(r.paid ? "success" : "fail");
      },
    });
  },
});
