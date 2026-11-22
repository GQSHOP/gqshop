/**
 * M1 unit tests — epay 协议、价格链、状态机（无 DB 依赖）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { epaySign, epayVerify } from "../src/lib/epay.js";
import {
  canTransition,
  calcTotalCents,
  centsToYuan,
  genOutTradeNo,
  unitPriceCents,
  yuanToCents,
} from "../src/lib/trade.js";
import { t } from "../src/lib/i18n.js";

describe("epay MD5 协议", () => {
  it("签名按 key 排序、跳过空值与 sign/sign_type", () => {
    const s = epaySign({ pid: "1001", type: "wxpay", out_trade_no: "GQ1", notify_url: "", sign_type: "MD5" }, "KEY123");
    // 参与签名的是 pid/out_trade_no/type（notify_url 空、sign_type 排除），ASCII 排序: out_trade_no < pid < type
    assert.equal(s, epaySign({ pid: "1001", type: "wxpay", out_trade_no: "GQ1" }, "KEY123"));
  });

  it("verify 对已签名参数返回 true，篡改返回 false", () => {
    const params = { pid: "1001", out_trade_no: "GQ1", money: "1.00", trade_status: "TRADE_SUCCESS" };
    const signed = { ...params, sign: epaySign(params, "KEY123"), sign_type: "MD5" };
    assert.equal(epayVerify(signed, "KEY123"), true);
    assert.equal(epayVerify({ ...signed, money: "9.99" }, "KEY123"), false);
    assert.equal(epayVerify({ ...signed }, "WRONG"), false);
    assert.equal(epayVerify({ foo: "bar" }, "KEY123"), false);
  });
});

describe("价格链与金额", () => {
  it("游客价优先，缺省回退市场价", () => {
    assert.equal(unitPriceCents({ guest_price: 990, market_price: 1200 }), 990);
    assert.equal(unitPriceCents({ guest_price: null, market_price: 1200 }), 1200);
    assert.equal(unitPriceCents({ guest_price: null, market_price: null }), 0);
  });
  it("总额 = 单价 × 数量；分↔元往返无损", () => {
    assert.equal(calcTotalCents(990, 3), 2970);
    assert.equal(yuanToCents(centsToYuan(2970)), 2970);
    assert.equal(yuanToCents("19.90"), 1990);
  });
  it("订单号格式与唯一性", () => {
    const a = genOutTradeNo();
    const b = genOutTradeNo();
    assert.match(a, /^GQ\d{12}[0-9A-F]{8}$/);
    assert.notEqual(a, b);
    assert.ok(a.length <= 30);
  });
});

describe("订单状态机（16.3 灵魂 #1）", () => {
  it("未支付可支付；重复支付被拒", () => {
    assert.equal(canTransition({ pay_status: 0, status: 0 }, "pay"), true);
    assert.equal(canTransition({ pay_status: 1, status: 1 }, "pay"), false);
  });
  it("已支付才可发货；未支付不可发货", () => {
    assert.equal(canTransition({ pay_status: 1, status: 1 }, "deliver"), true);
    assert.equal(canTransition({ pay_status: 0, status: 0 }, "deliver"), false);
    assert.equal(canTransition({ pay_status: 1, status: 2 }, "deliver"), false);
  });
});

describe("i18n 地基", () => {
  it("中文缺省 + 英文切换 + 参数插值", () => {
    assert.equal(t("zh-CN", "error.outOfStock"), "库存不足");
    assert.equal(t("en", "error.outOfStock"), "Out of stock");
    assert.equal(t("zh-CN", "ok.delivered"), "发货完成");
  });
});
