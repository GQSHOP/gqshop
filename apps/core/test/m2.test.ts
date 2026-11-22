/**
 * M2 unit tests — 会员价链优先级、佣金计算、超时窗口。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { epayTypeFromPlugin } from "@gqshop/kernel";
import { centsToYuan } from "@gqshop/kernel";
import { MEMBER_SEEDS } from "@gqshop/domain-members";
import { applyBestDiscount } from "@gqshop/domain-trade";

describe("支付通道映射", () => {
  it("epay_ali→alipay / epay_wx→wxpay / 其他→null", () => {
    assert.equal(epayTypeFromPlugin("epay_ali"), "alipay");
    assert.equal(epayTypeFromPlugin("epay_wx"), "wxpay");
    assert.equal(epayTypeFromPlugin("balance"), null);
    assert.equal(epayTypeFromPlugin(null), null);
  });
});

describe("会员种子（上游 install.sql 原值）", () => {
  it("8 档，普通用户默认且免费，最高核心合伙人 199.90", () => {
    assert.equal(MEMBER_SEEDS.length, 8);
    assert.equal(MEMBER_SEEDS[0].name, "普通用户");
    assert.equal(MEMBER_SEEDS[0].is_default, 1);
    assert.equal(MEMBER_SEEDS[0].price, "0.00");
    assert.equal(MEMBER_SEEDS[7].name, "核心合伙人");
    assert.equal(MEMBER_SEEDS[7].price, "199.90");
    // 全部永久（duration_days=0）
    assert.ok(MEMBER_SEEDS.every((m) => m.duration_days === 0));
  });
});

describe("金额换算（佣金入账一致）", () => {
  it("分→元保留两位", () => {
    assert.equal(centsToYuan(990), "9.90");
    assert.equal(centsToYuan(5), "0.05");
  });
});

describe("批量优惠（M2 收尾）", () => {
  const unit = 990; // ¥9.90

  it("无规则 / 未达门槛 → 0", () => {
    assert.equal(applyBestDiscount([], 5, unit).discountCents, 0);
    const r = applyBestDiscount([{ quantity: 10, amount: "1.00", type: 1 }], 5, unit);
    assert.equal(r.discountCents, 0);
    assert.equal(r.rule, null);
  });

  it("type=1 整单立减：满 2 件减 1 元", () => {
    const r = applyBestDiscount([{ quantity: 2, amount: "1.00", type: 1 }], 3, unit);
    assert.equal(r.discountCents, 100);
  });

  it("type=2 每件立减：满 2 件每件减 0.5 元 × 3 件", () => {
    const r = applyBestDiscount([{ quantity: 2, amount: "0.50", type: 2 }], 3, unit);
    assert.equal(r.discountCents, 150);
  });

  it("type=3 折扣：满 3 件 9 折（amount=90）", () => {
    const r = applyBestDiscount([{ quantity: 3, amount: "90", type: 3 }], 3, unit);
    // 990×3=2970 → 9 折优惠 = 297
    assert.equal(r.discountCents, 297);
  });

  it("多规则取对买家最优", () => {
    const rules = [
      { quantity: 2, amount: "1.00", type: 1 }, // -100
      { quantity: 2, amount: "0.50", type: 2 }, // -150（3 件）
      { quantity: 3, amount: "80", type: 3 },   // 2970×20% = -594
    ];
    const r = applyBestDiscount(rules, 3, unit);
    assert.equal(r.discountCents, 594);
    assert.equal(r.rule!.type, 3);
  });
});
