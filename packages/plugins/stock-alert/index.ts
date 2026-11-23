/**
 * v1.2.0 运营插件②：库存告警 webhook。
 * 订阅 stock:low（支付扣库存后 ≤10 触发，trade 域 pay.ts），
 * POST JSON 到管理员配置的 webhook URL（企业微信/飞书/钉钉机器人通用），
 * 带 X-GQSHOP-Timestamp + X-GQSHOP-Signature（HMAC-SHA256(secret, `${ts}.${body}`)）可验签防伪。
 * 去抖：同一商品 min_interval_sec 内只发一次（默认 1800s）；URL 经 SSRF 防线校验（禁私网）。
 */
import { createHmac } from "node:crypto";

import { definePlugin, type PluginContext } from "@gqshop/plugin-api";
import { assertPublicHttpUrl } from "@gqshop/kernel";

const CONFIG_OPTION = "plugin_config:stock_alert";

interface AlertConfig {
  webhook_url: string;
  webhook_secret: string;
  min_interval_sec: number;
}

async function readConfig(ctx: PluginContext): Promise<AlertConfig | null> {
  const raw = await ctx.options.get(CONFIG_OPTION);
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const url = String(parsed.webhook_url ?? "");
  if (!url || !url.startsWith("https://")) return null; // 仅 https：企微/飞书/钉钉机器人均 https，直接排除 http SSRF 面
  return {
    webhook_url: url,
    webhook_secret: String(parsed.webhook_secret ?? ""),
    min_interval_sec: Number(parsed.min_interval_sec) > 0 ? Number(parsed.min_interval_sec) : 1800,
  };
}

/** 商品级去抖表（进程内存；重启即清零，可接受——告警重发优于漏发）。 */
const lastSent = new Map<number, number>();

export default definePlugin({
  name: "stock_alert",
  version: "1.0.0",
  description: "库存告警 webhook：stock:low → 签名 POST（HMAC-SHA256 防伪 + 商品级去抖，适配企微/飞书/钉钉机器人）",
  configSchema: [
    { key: "webhook_url", label: "Webhook URL（仅 https）", type: "string", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" },
    { key: "webhook_secret", label: "签名密钥", type: "password", hint: "留空则不签名；设置后接收方可按 HMAC-SHA256(secret, `${时间戳}.${body}`) 验签" },
    { key: "min_interval_sec", label: "同商品去抖间隔（秒）", type: "number", hint: "默认 1800（30 分钟）" },
  ],
  activate(ctx) {
    ctx.bus.on("stock_alert", "stock:low", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg) return;
      const now = Date.now();
      const last = lastSent.get(p.goodsId) ?? 0;
      if (now - last < cfg.min_interval_sec * 1000) {
        ctx.log(`stock:low goods#${p.goodsId} 去抖窗口内，跳过`);
        return;
      }
      // SSRF 防线：管理员配置的 URL 也必须过公网校验（防容器内网探测）
      try {
        assertPublicHttpUrl(cfg.webhook_url);
      } catch (err) {
        ctx.log(`webhook_url 被拦截: ${String(err).slice(0, 120)}`);
        return;
      }
      const g = await ctx.query.query<{ rows: Array<{ title: string | null }> }>(
        `SELECT title FROM gq_goods WHERE id = $1 LIMIT 1`,
        [p.goodsId],
      );
      const title = g.rows[0]?.title ?? `商品#${p.goodsId}`;
      const body = JSON.stringify({
        event: "stock:low",
        goods_id: p.goodsId,
        title,
        stock: p.stock,
        ts: Math.floor(now / 1000),
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-gqshop-event": "stock:low",
      };
      if (cfg.webhook_secret) {
        const ts = String(Math.floor(now / 1000));
        const sig = createHmac("sha256", cfg.webhook_secret).update(`${ts}.${body}`).digest("hex");
        headers["x-gqshop-timestamp"] = ts;
        headers["x-gqshop-signature"] = sig;
      }
      try {
        const res = await fetch(cfg.webhook_url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(8000),
          redirect: "error", // SSRF 双防线之二：禁止重定向绕过 assertPublicHttpUrl 校验（同 pay-epay）
        });
        if (!res.ok) {
          ctx.log(`webhook 响应异常 HTTP ${res.status}`);
          return; // 失败不占去抖名额，下次事件可重试
        }
        lastSent.set(p.goodsId, now);
        ctx.log(`库存告警已推送 goods#${p.goodsId}（${title}）库存=${p.stock}`);
      } catch (err) {
        ctx.log(`webhook 推送失败: ${String(err).slice(0, 120)}`);
      }
    });
    ctx.log("库存告警 webhook 就绪（未配置 URL 时静默跳过）");
  },
});
