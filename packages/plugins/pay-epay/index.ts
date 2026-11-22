import { definePlugin } from "@gqshop/plugin-api";

export default definePlugin({
  name: "pay_epay",
  version: "0.1.0",
  description: "易支付通道（支付宝/微信；MD5 验签回调与 submit 代取路由在 core，M6 完全化）",
  activate(ctx) {
    ctx.registerPayPlugin({ name: "epay_ali", label: "支付宝（易支付）", kind: "epay" });
    ctx.registerPayPlugin({ name: "epay_wx", label: "微信（易支付）", kind: "epay" });
  },
});
