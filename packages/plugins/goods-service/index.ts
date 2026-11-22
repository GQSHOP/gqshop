import { definePlugin, type OrderItemRef } from "@gqshop/plugin-api";

export default definePlugin({
  name: "goods_service",
  version: "0.1.0",
  description: "虚拟服务：交付内容直接下发（人工/自动服务内容）",
  activate(ctx) {
    ctx.registerGoodsType({
      type: "goods_service",
      label: "虚拟服务",
      deliver: async (pool, orderId, item: OrderItemRef) => {
        const goodsId = item.goods_id ?? 0;
        try {
          const r = await pool.query<{ rows: Array<{ content: string | null }> }>(
            `SELECT content FROM dc_goods_service
             WHERE goods_id = $1 AND content IS NOT NULL
             ORDER BY id ASC LIMIT 1`,
            [goodsId],
          );
          const content = (r.rows[0] as { content: string | null } | undefined)?.content ?? null;
          if (content === null) return { delivered: false, contents: [], error: "service content empty" };
          await ctx.bus.emit("deliver:after", { orderId, goodsType: "goods_service", contents: [content] });
          return { delivered: true, contents: [content] };
        } catch (err) {
          return { delivered: false, contents: [], error: String(err).slice(0, 300) };
        }
      },
    });
  },
});
