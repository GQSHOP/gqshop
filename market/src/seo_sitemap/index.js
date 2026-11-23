/**
 * SEO 基建插件：自动生成 sitemap.xml 与 robots.txt。
 * - GET /sitemap.xml：首页 + 在售商品（/goods/:id）+ 已发布博客（/blog/:key），合计最多 1000 条；
 * - GET /robots.txt：允许全部抓取 + 指向 sitemap。
 * 域名取请求自身 origin（多域名/分店部署各自生效），零配置，安装重启即得。
 */
export default {
  name: "seo_sitemap",
  version: "1.0.1",
  description: "SEO 基建：自动生成 /sitemap.xml（商品+博客）与 /robots.txt",
  activate(ctx) {
    const MAX_URLS = 1000;

    /** 反代后真实 origin：优先 x-forwarded-proto/-host（TLS 终止在 nginx 时 c.req.url 是 http）。 */
    const requestOrigin = (c) => {
      const u = new URL(c.req.url);
      const proto = c.req.header("x-forwarded-proto") || u.protocol.replace(":", "");
      const host = c.req.header("x-forwarded-host") || u.host;
      return `${proto}://${host}`;
    };

    ctx.registerRoute({
      method: "GET",
      path: "/sitemap.xml",
      handler: async (c) => {
        const origin = requestOrigin(c);
        const goods = await ctx.query.query(
          `SELECT id FROM gq_goods
           WHERE station_id = 0 AND is_on_shelf = 1 AND delete_time IS NULL
           ORDER BY id ASC LIMIT $1`,
          [MAX_URLS],
        );
        const blogs = await ctx.query.query(
          `SELECT gid, alias FROM gq_blog
           WHERE type = 'blog' AND hide = 'n' AND checked = 'y'
           ORDER BY gid ASC LIMIT $1`,
          [MAX_URLS],
        );
        const urls = [`${origin}/`, `${origin}/blog`];
        for (const g of goods.rows) urls.push(`${origin}/goods/${g.id}`);
        for (const b of blogs.rows) urls.push(`${origin}/blog/${encodeURIComponent(String(b.alias || b.gid))}`);
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          urls.map((u) => `  <url><loc>${u.replace(/&/g, "&amp;")}</loc></url>`).join("\n") +
          `\n</urlset>\n`;
        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
        });
      },
    });

    ctx.registerRoute({
      method: "GET",
      path: "/robots.txt",
      handler: (c) => {
        const origin = requestOrigin(c);
        const body = `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
        });
      },
    });

    ctx.log("seo_sitemap 已注册：GET /sitemap.xml + /robots.txt");
  },
};
