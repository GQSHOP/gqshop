# GQSHOP 搞钱商城

**自部署开源电商系统**——虚拟商品 / 卡密自动发货 / 会员分销 / 分店多租户 / 插件扩展，TypeScript + Node.js + Hono + PostgreSQL 现代技术栈。

<p>
  <img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0-blue">
  <img alt="status" src="https://img.shields.io/badge/release-v1.0.0-brightgreen">
  <img alt="stack" src="https://img.shields.io/badge/stack-TypeScript%20·%20Hono%20·%20PostgreSQL-blueviolet">
</p>

- 文档：`docs/`（部署与配置）· 数据库 78 表 schema（`tools/gen-drizzle.py` 可再生）
- 反馈渠道：GitHub Issues

## 这是什么

一套面向虚拟商品卖家（发卡 / 兑换码 / 会员订阅 / 虚拟服务 / 实物商品）的**自部署商城系统**：

- **交易闭环**：游客下单 → 支付宝/微信（易支付协议）或余额 → 卡密自动发货 → 订单查询，全程无人工干预；幂等下单、库存原子预留、超时关单与迟到回调恢复
- **四种商品类型**：一卡一密（SKIP LOCKED 原子取卡）/ 通用卡密 / 虚拟服务 / 实物（运费模板+物流发货）
- **会员资金**：8 档等级价格链、余额充值卡、多级分销佣金、提现全状态机、批量优惠
- **分店多租户**：5 档等级自助开通、分店价格链与即时分成、独立域名或 `/s/{slug}` 双模式、分店自选模板
- **内容系统**：博客（文章/分类/评论审核/RSS）
- **扩展体系**：模板多构建（一包一模板）+ 进程内插件总线（商品类型/支付通道注册表化，新增零改 core）+ admin 用户组权限位

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
docker compose up -d --build   # 需先配置 .env（数据库/JWT/ADMIN_KEY，见 docs）
```

## 目录结构（开源子集）

```
apps/core            # 后端 API（交易/资金/分店/博客/插件宿主）
apps/{admin,user}    # 管理后台 / 用户中心 SPA
templates/{default,minimal}   # 店面模板（一包一模板）
packages/plugins/*   # 插件契约 + 5 个内置插件（goods×3 / pay×2）
packages/db          # Drizzle schema（78 表）
```

## 声明

- 本项目为独立开发的开源项目，与任何第三方商城系统无隶属或背书关系
- 商用部署需自行取得支付通道资质并遵守当地法规

## 路线图

- ✅ **M1** 交易闭环 MVP（真实支付 E2E）
- ✅ **M2** 会员等级定价 · 余额充值 · 分销佣金 · 提现 · 售后
- ✅ **M3** 分店多租户 · 实物商城 · 博客
- ✅ **M4** 店面视觉体系（皮肤样式 + 组件结构对齐）
- ✅ **M5** 模板多构建 · 插件系统 · admin 权限组（v1.0.0）
- ⬜ **M6** 应用市场 + 在线升级 + 企业版授权（Open Core 双许可）

## 开源许可

[AGPL-3.0](./LICENSE)。插件与模板的信任模型见 [SECURITY.md](./SECURITY.md)。企业版商业许可随 M6 授权体系上线。
