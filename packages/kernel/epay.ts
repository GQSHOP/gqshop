/**
 * 易支付协议（epay）MD5 签名/验签 —— 1:1 兼容 上游 生态（附录 A4 生命线）。
 * 规则：参数按 key ASCII 升序，空值与 sign/sign_type 排除，k=v& 拼接后 + key（商户密钥），
 * md5 小写。
 */
import { createHash } from "node:crypto";

export function epaySign(params: Record<string, string>, merchantKey: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== undefined)
    .sort();
  const qs = keys.map((k) => `${k}=${params[k]}`).join("&");
  return createHash("md5").update(qs + merchantKey, "utf8").digest("hex");
}

export function epayVerify(params: Record<string, string>, merchantKey: string): boolean {
  const sign = params.sign;
  if (!sign) return false;
  return epaySign(params, merchantKey) === sign.toLowerCase();
}

export const EPAY_TRADE_SUCCESS = "TRADE_SUCCESS";

/** 订单支付插件 -> 易支付 type（epay_ali→alipay、epay_wx→wxpay；非 epay 通道返回 null）。 */
export function epayTypeFromPlugin(plugin: string | null): "alipay" | "wxpay" | null {
  if (plugin === "epay_ali") return "alipay";
  if (plugin === "epay_wx") return "wxpay";
  return null;
}
