/**
 * v1.2.0 运营插件①：邮件通知。
 * 订阅 order:created / pay:settled / aftersale:created / deliver:failed 四事件，
 * SMTP 配置存 gq_options（plugin_config:notify_email，admin 插件页表单读写），
 * 每次事件即读即用（改配置无需重启）；未配置 SMTP 时静默跳过（安全 no-op）。
 * 凭据只来自运行时配置（admin 录入），源码/示例零硬编码（Mimosa 约束）。
 */
import nodemailer from "nodemailer";

import { definePlugin, type PluginContext } from "@gqshop/plugin-api";

interface MailConfig {
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_pass: string;
  mail_from: string;
  mail_to: string;
  subject_prefix: string;
  notify_order_created: boolean;
  notify_pay_settled: boolean;
  notify_aftersale_created: boolean;
  notify_deliver_failed: boolean;
}

const DEFAULTS: Partial<MailConfig> = {
  smtp_port: 465,
  smtp_secure: true,
  subject_prefix: "[GQSHOP]",
  notify_order_created: true,
  notify_pay_settled: true,
  notify_aftersale_created: true,
  notify_deliver_failed: true,
};

const CONFIG_OPTION = "plugin_config:notify_email";

/** 每事件现读配置（admin 改完即生效）。基础校验不齐=未配置，静默跳过。 */
async function readConfig(ctx: PluginContext): Promise<MailConfig | null> {
  const raw = await ctx.options.get(CONFIG_OPTION);
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cfg = { ...DEFAULTS, ...parsed } as MailConfig;
  if (!cfg.smtp_host || !cfg.mail_to || !cfg.smtp_user || !cfg.smtp_pass) return null;
  return cfg;
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 发送一封纯文本邮件；失败仅记日志（总线亦有异常隔离，不阻断主流程）。 */
async function send(ctx: PluginContext, cfg: MailConfig, subject: string, text: string): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: Number(cfg.smtp_port) || 465,
    secure: cfg.smtp_secure !== false,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const to = cfg.mail_to.split(/[,;\s]+/).filter(Boolean).slice(0, 10);
  try {
    const info = await transporter.sendMail({
      from: cfg.mail_from || cfg.smtp_user,
      to,
      subject: `${cfg.subject_prefix || ""} ${subject}`.trim(),
      text,
    });
    ctx.log(`邮件已发: ${subject} -> ${to.join(",")} (${info.messageId})`);
  } finally {
    transporter.close();
  }
}

export default definePlugin({
  name: "notify_email",
  version: "1.0.0",
  description: "运营邮件通知：新订单/支付成功/新售后/发货失败 → SMTP 邮件（事件粒度可开关）",
  configSchema: [
    { key: "smtp_host", label: "SMTP 服务器", type: "string", placeholder: "smtp.example.com" },
    { key: "smtp_port", label: "SMTP 端口", type: "number", hint: "SSL 通常 465，STARTTLS 587" },
    { key: "smtp_secure", label: "SSL 直连（465）", type: "boolean", hint: "587 端口请关闭（走 STARTTLS）" },
    { key: "smtp_user", label: "SMTP 用户名", type: "string" },
    { key: "smtp_pass", label: "SMTP 密码/授权码", type: "password" },
    { key: "mail_from", label: "发件人地址", type: "string", hint: "留空则用 SMTP 用户名" },
    { key: "mail_to", label: "收件人", type: "string", placeholder: "ops@example.com", hint: "多人用逗号分隔" },
    { key: "subject_prefix", label: "邮件主题前缀", type: "string", hint: "默认 [GQSHOP]" },
    { key: "notify_order_created", label: "通知：新订单", type: "boolean" },
    { key: "notify_pay_settled", label: "通知：支付成功", type: "boolean" },
    { key: "notify_aftersale_created", label: "通知：新售后", type: "boolean" },
    { key: "notify_deliver_failed", label: "通知：发货失败", type: "boolean" },
  ],
  activate(ctx) {
    ctx.bus.on("notify_email", "order:created", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg || cfg.notify_order_created === false) return;
      const g = await ctx.query.query<{ rows: Array<{ title: string | null; quantity: number | null }> }>(
        `SELECT g.title, ol.quantity FROM gq_order_list ol
         LEFT JOIN gq_goods g ON g.id = ol.goods_id WHERE ol.order_id = $1 LIMIT 1`,
        [p.orderId],
      );
      const title = g.rows[0]?.title ?? "未知商品";
      const qty = g.rows[0]?.quantity ?? 1;
      await send(ctx, cfg, `新订单 ${p.outTradeNo} 待支付 ¥${yuan(p.amountCents)}`,
        `新订单待支付\n\n订单号：${p.outTradeNo}\n商品：${title} × ${qty}\n金额：¥${yuan(p.amountCents)}\n用户 uid：${p.userId}\n时间：${new Date().toLocaleString("zh-CN")}`);
    });

    ctx.bus.on("notify_email", "pay:settled", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg || cfg.notify_pay_settled === false) return;
      await send(ctx, cfg, `订单已支付 ¥${yuan(p.amountCents)}（${p.gateway}）`,
        `订单支付成功\n\n订单号：${p.outTradeNo ?? `#${p.orderId}`}\n金额：¥${yuan(p.amountCents)}\n支付通道：${p.gateway}\n时间：${new Date().toLocaleString("zh-CN")}`);
    });

    ctx.bus.on("notify_email", "aftersale:created", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg || cfg.notify_aftersale_created === false) return;
      const a = await ctx.query.query<{ rows: Array<{ out_trade_no: string; goods_title: string; type: string; reason: string | null }> }>(
        `SELECT out_trade_no, goods_title, type, reason FROM gq_aftersale WHERE id = $1 LIMIT 1`,
        [p.aftersaleId],
      );
      const row = a.rows[0];
      const typeLabel = row?.type === "refund" ? "退款" : row?.type === "resend" ? "补发" : "其他";
      await send(ctx, cfg, `新售后 #${p.aftersaleId}（${typeLabel}）`,
        `收到新的售后申请\n\n售后单：#${p.aftersaleId}\n订单号：${row?.out_trade_no ?? `#${p.orderId}`}\n商品：${row?.goods_title ?? "-"}\n类型：${typeLabel}\n原因：${row?.reason ?? "-"}\n时间：${new Date().toLocaleString("zh-CN")}`);
    });

    ctx.bus.on("notify_email", "deliver:failed", async (p) => {
      const cfg = await readConfig(ctx);
      if (!cfg || cfg.notify_deliver_failed === false) return;
      await send(ctx, cfg, `发货失败 订单 #${p.orderId}`,
        `自动发货失败，请人工处理\n\n订单：#${p.orderId}\n商品类型：${p.goodsType}\n错误：${p.error}\n时间：${new Date().toLocaleString("zh-CN")}`);
    });

    ctx.log("运营邮件通知就绪（未配置 SMTP 时静默跳过）");
  },
});
