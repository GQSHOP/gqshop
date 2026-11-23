# GQSHOP 搞钱商城

**自部署开源电商系统**——虚拟商品 / 卡密自动发货 / 会员分销 / 分店多租户 / 插件市场，TypeScript + Node.js + Hono + PostgreSQL 现代技术栈。

<p>
  <img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0-blue">
  <img alt="status" src="https://img.shields.io/badge/release-v1.4.0-brightgreen">
  <img alt="stack" src="https://img.shields.io/badge/stack-TypeScript%20·%20Hono%20·%20PostgreSQL-blueviolet">
</p>

- 文档：插件开发与市场接入见[开发者文档](https://license.sc9.top/docs.html) · 数据库 78 表 schema（`tools/gen-drizzle.py` 可再生）
- 反馈渠道：GitHub Issues

## 这是什么

一套面向虚拟商品卖家（发卡 / 兑换码 / 会员订阅 / 虚拟服务 / 实物商品）的**自部署商城系统**：

- **交易闭环**：游客下单 → 支付宝/微信（易支付协议）或余额 → 卡密自动发货 → 订单查询，全程无人工干预；幂等下单、库存原子预留、超时关单与迟到回调恢复
- **五种商品形态**：一卡一密（SKIP LOCKED 原子取卡）/ 通用卡密 / 虚拟服务 / 实物（运费模板+物流发货）/ 插件自定义类型；密码商品与付费内容（购买后商品页解锁）
- **会员资金**：8 档等级价格链（游客/注册/会员三级定价，到期自动降档）、余额充值卡、多级分销佣金（池模型+起提线+反扣）、提现全状态机、批量优惠
- **分店多租户**：5 档等级自助开通、分店价格链与即时分成、独立域名或 `/s/{slug}` 双模式、分店自选模板、分店级插件白名单（支付通道管控）、业绩自动升档
- **内容系统**：博客（文章/分类/评论审核）
- **扩展体系**：内核-域-插件三层架构（域间零横向依赖）· 模板多构建（一包一模板）· 进程内插件总线（商品类型/支付通道/自定义路由/仪表盘卡片/事件通知）· admin 用户组权限位 · 高级定价层（全场统一价/成本加成/目标利润）
- **应用市场**（v1.3 运营级）：开发者账号与上架审核（自动扫描+人工审）→ 平台 ed25519 签名分发 → 店主一键安装（哈希+签名双验，篡改即拒）→ 付费插件 license（域名绑定）→ SVIP 全插件订阅 → 平台抽成结算与报表

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | TypeScript · Node.js 24 · Hono |
| 数据库 | PostgreSQL 17（78 表 schema）+ Redis 7.4 |
| 前台 | React 19 + Vite（店面模板 ×2 / 管理后台 / 用户中心） |
| 部署 | Docker Compose |

## 快速部署

```bash
git clone https://github.com/GQSHOP/gqshop.git
cd gqshop
docker compose up -d --build   # 需先配置 .env（数据库/JWT 等）
```

## 目录结构（开源子集）

```
apps/core            # 后端 API 装配薄壳（交易/资金/分店/博客/插件宿主）
apps/license         # 市场站服务（账号/上架审核/签名分发/付费 license/结算）
apps/{admin,user}    # 管理后台 / 用户中心 SPA
packages/kernel      # 横切内核（鉴权/插件宿主/市场安装/模板注册表）
packages/domains/*   # 业务域（trade/wallet/station/content/members，域间零横向依赖）
packages/plugins/*   # 插件契约 + 8 个内置插件（goods×3 / pay×2 / 运营×3）
templates/{default,minimal}   # 店面模板（一包一模板）
sites/{license,www}  # 市场站 / 官网静态页
market/src/*         # 官方市场插件源（seo_sitemap / order_webhook / today_snapshot / advanced_stats）
packages/db          # Drizzle schema（78 表）
```

## 应用市场生态

官方市场（[license.sc9.top](https://license.sc9.top)）已上架运营级插件：

| 插件 | 定价 | 说明 |
|---|---|---|
| `seo_sitemap` | 免费 | /sitemap.xml + /robots.txt 自动生成 |
| `order_webhook` | 免费 | 新订单/支付/售后 webhook 推送（HMAC 签名防伪） |
| `today_snapshot` | 免费 | 仪表盘「今日快照」卡片 |
| `advanced_stats` | 买断 | 商品销量 Top10 / 支付转化率 / 复购率三卡 |

自建市场源亦支持（`GQSHOP_MARKET_DIR` 本地目录或 `GQSHOP_MARKET_URL` 远端）。插件开发规范见[开发者文档](https://license.sc9.top/docs.html)。

## 声明

- 本项目为独立开发的开源项目，与任何第三方商城系统无隶属或背书关系
- 商用部署需自行取得支付通道资质并遵守当地法规

## 路线图

- ✅ **M1** 交易闭环 MVP（真实支付 E2E）
- ✅ **M2** 会员等级定价 · 余额充值 · 分销佣金 · 提现 · 售后
- ✅ **M3** 分店多租户 · 实物商城 · 博客
- ✅ **M4** 店面视觉体系
- ✅ **M5** 模板多构建 · 插件系统 · admin 权限组
- ✅ **R1/R2** 命名自主 · 内核-域拆包（域间零横向依赖）
- ✅ **M6** 应用市场：签名分发 · 安装/升级/回滚 · 付费 license · SVIP
- ✅ **M8** 官网 / 市场站 / 在线演示矩阵（TLS 全站）
- ✅ **v1.3** 市场站运营级：账号审核上架 · epay 付费 · license 生命周期 · 结算报表 · 官方插件生态
- ✅ **v1.4** 功能池：等级到期降级 · 密码商品/付费内容 · 分店插件白名单 · 高级定价层与分店自动升档

## 开源许可

[AGPL-3.0](./LICENSE)。插件与模板的信任模型见 [SECURITY.md](./SECURITY.md)。
