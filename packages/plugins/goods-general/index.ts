import { definePlugin, type OrderItemRef } from "@gqshop/plugin-api";

export default definePlugin({
  name: "goods_general",
  version: "0.1.0",
  description: "通用卡密：共用卡池，同一内容可重复发（留痕 gq_goods_general_sale）",
  activate(ctx) {
    ctx.registerGoodsType({
      type: "goods_general",
      label: "通用卡密",
      deliver: async (pool, orderId, item: OrderItemRef) => {
        const sku = item.sku ?? "0";
        const goodsId = item.goods_id ?? 0;
        const qty = Math.max(1, item.quantity ?? 1);
        try {
          const base = await pool.query<{ rows: Array<{ content: string | null }> }>(
            `SELECT content FROM gq_goods_general
             WHERE goods_id = $1 AND sku = $2 AND content IS NOT NULL AND content <> ''
             ORDER BY id ASC LIMIT 1`,
            [goodsId, sku],
          );
          const content = (base.rows[0] as { content: string | null } | undefined)?.content ?? null;
          if (content === null) return { delivered: false, contents: [], error: "general pool empty" };
          await pool.query(
            `INSERT INTO gq_goods_general_sale (goods_id, order_list_id, sku, content, num, create_time, update_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [goodsId, item.id, sku, content, qty, Date.now(), Date.now()],
          );
          const contents = Array.from({ length: qty }, () => content);
          await ctx.bus.emit("deliver:after", { orderId, goodsType: "goods_general", contents });
          return { delivered: true, contents };
        } catch (err) {
          return { delivered: false, contents: [], error: String(err).slice(0, 300) };
        }
      },
    });
  },
});
