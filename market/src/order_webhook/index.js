/**
 * 订单事件通知插件：order:created / pay:settled / aftersale:created 三事件实时推 webhook。
 * - POST JSON 到管理员配置的 https webhook（企微/飞书/钉钉机器人通用）；
 * - 带 X-GQSHOP-Timestamp + X-GQSHOP-Signature（HMAC-SHA256(secret, `${ts}.${body}`)）可验签防伪；
 * - SSRF 防线（内置版 kernel 校验的市场等价实现）：仅 https + 内网地址黑名单 + 禁重定向 + 8s 超时；
 * - 未配置 URL 时静默跳过；推送失败不影响主流程（总线异常隔离）。
 */
import { createHmac } from "node:crypto";

const CONFIG_OPTION = "plugin_config:order_webhook";

function readConfig(ctx) {
  return ctx.options.get(CONFIG_OPTION).then((raw) => {
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const url = String(parsed.webhook_url ?? "");
    if (!url || !url.startsWith("https://")) return null; // 仅 https：主流机器人均 https，排除 http SSRF 面
    return {
      webhook_url: url,
      webhook_secret: String(parsed.webhook_secret ?? ""),
      include_order: parsed.include_order === false ? false : true,
    };
  });
}

/** 内联 SSRF 防线（市场插件不可引 @gqshop/kernel，与 assertPublicHttpUrl 同规则的本地实现）。 */
function assertPublicHttps(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("URL 解析失败");
  }
  if (u.protocol !== "https:") throw new Error("仅允许 https:// 目标");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") {
    throw new Error(`内网域名被拒: ${h}`);
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error(`内网 IPv4 被拒: ${h}`);
    }
  } else if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("ff")) {
      throw new Error(`内网/链路本地 IPv6 被拒: ${h}`);
    }
  }
  return u;
}

async function push(ctx, cfg, event, payload) {
  try {
    assertPublicHttps(cfg.webhook_url);
  } catch (err) {
    ctx.log(`webhook_url 被拦截: ${String(err).slice(0, 120)}`);
    return;
  }
  const now = Date.now();
  const body = JSON.stringify({ event, ts: Math.floor(now / 1000), data: payload });
  const headers = { "content-type": "application/json", "x-gqshop-event": event };
  if (cfg.webhook_secret) {
    const ts = String(Math.floor(now / 1000));
    headers["x-gqshop-timestamp"] = ts;
    headers["x-gqshop-signature"] = createHmac("sha256", cfg.webhook_secret).update(`${ts}.${body}`).digest("hex");
  }
  try {
    const res = await fetch(cfg.webhook_url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(8000),
      redirect: "error", // 禁重定向绕过内网校验
    });
    if (!res.ok) ctx.log(`webhook 响应异常 HTTP ${res.status}`);
    else ctx.log(`已推送 ${event}`);
  } catch (err) {
    ctx.log(`webhook 推送失败: ${String(err).slice(0, 120)}`);
  }
}

const yuan = (cents) => `¥${(cents / 100).toFixed(2)}`;

export default {
  name: "order_webhook",
  version: "1.0.0",
  description: "订单事件通知：新订单/支付成功/新售后 webhook 推送（HMAC 签名防伪）",
  configSchema: [
    { key: "webhook_url", label: "Webhook URL（仅 https）", type: "string", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" },
    { key: "webhook_secret", label: "签名密钥", type: "password", hint: "留空不签名；设置后接收方按 HMAC-SHA256(secret, `${时间戳}.${body}`) 验签" },
    { key: "include_order", label: "新订单事件（order:created）", type: "boolean", hint: "关闭后只推支付成功与新售后" },
  ],
  activate(ctx) {
    ctx.bus.on("order_webhook", "order:created", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg || !cfg.include_order) return;
      await push(ctx, cfg, "order:created", { order_id: p.orderId, out_trade_no: p.outTradeNo, user_id: p.userId, amount: yuan(p.amountCents) });
    });
    ctx.bus.on("order_webhook", "pay:settled", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg) return;
      await push(ctx, cfg, "pay:settled", { order_id: p.orderId, gateway: p.gateway, out_trade_no: p.outTradeNo ?? "", amount: yuan(p.amountCents) });
    });
    ctx.bus.on("order_webhook", "aftersale:created", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg) return;
      const r = await ctx.query.query(
        `SELECT out_trade_no, goods_title, type FROM gq_aftersale WHERE id = $1 LIMIT 1`,
        [p.aftersaleId],
      );
      const a = r.rows[0];
      await push(ctx, cfg, "aftersale:created", { aftersale_id: p.aftersaleId, order_no: a?.out_trade_no ?? String(p.orderId), goods_title: a?.goods_title ?? "", type: a?.type ?? "" });
    });
    ctx.log("订单事件 webhook 就绪（未配置 URL 时静默跳过）");
  },
};
