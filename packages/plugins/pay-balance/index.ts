import { definePlugin } from "@gqshop/plugin-api";

export default definePlugin({
  name: "pay_balance",
  version: "0.1.0",
  description: "余额支付（登录用户，原子扣款；路由 core /pay-balance）",
  activate(ctx) {
    ctx.registerPayPlugin({ name: "balance", label: "余额支付", kind: "balance" });
  },
});
