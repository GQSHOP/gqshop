# Changelog

本项目的所有显著变更记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.1.0] - 2026-11-23

架构自主与生态闭环版本：命名自主、内核-域三层架构、应用市场、佣金真算法。

### 新增（M6 应用市场，ADR-011）
- **可信分发链**：市场包 sha256 + ed25519 双验签、zip-slip 防护、manifest 白名单校验
- **市场源抽象**：本地目录（LocalMarketSource）/ HTTP 远端（HttpMarketSource，SSRF 防线）
- **安装/升级/回滚/卸载**：版本目录共存 + installed.json 指针；重启生效（不热加载）
- **外部插件动态加载**：installed.json → data/plugins/{name}/{version}/index.js，失败隔离
- **admin 应用市场页**：浏览/安装/升级/回滚/卸载 + 密钥工具链（market-keys/pack-plugin）
- **epay 路由完全插件化**（M6-γ）：PluginContext.registerRoute 扩展点；pay-epay 插件接管
  submit（代取+SSRF 防线）与 notify（MD5 验签+回调日志）——新增支付通道零改 core
- **X-Admin-Key 机器通道默认退役**：admin 会话票唯一通道（GQSHOP_ADMIN_KEY_CHANNEL=on 兼容开关，下版删除）

### 新增（R1 命名自主，ADR-010）
- 表前缀 dc_→gq_（78 表 + 索引/序列 + 0003 RENAME 迁移）、CSS 命名空间 dc-→gq-、gqskin 资产目录

### 新增（R2 内核-域拆包，ADR-010）
- **packages/kernel**（横切内核）+ **packages/domains/{trade,wallet,station,content,members}** 五域包
- apps/core 瘦身为装配薄壳；**域间零横向依赖**（事件总线 + 注册表解耦，CI 门禁强制）
- 事件总线事务透传：pay:settled 携带 executor，佣金/分店分成/实物发货单与结算同事务（资金原子性保持）

### 新增（M7 代码级对标，ADR-009）
- **佣金真算法**（还原对齐）：池模型（total/profit 成本差基数）、池递减链、起提线、池帽、
  等级门槛/无限分销/跳级、分店互斥、退款反扣、升级佣金
- **价格链补 user_price 层**（注册用户价）+ 会员价过期校验 + stock:low 告警事件

### 安全
- M5 全面审计修复（3 高危 + 3 中危 + 5 低危）：余额支付统一履约、关单超卖、详情脱敏、
  越权替付、提现流水、双发窗口；IPv6 SSRF 拦截；登录限流锁定
- 市场密钥轮换事件响应（E2E 私钥误入库即作废轮换，无实际影响）

## [1.0.0] - 2026-11-22

首个完整版本：交易闭环 + 会员资金 + 多租户 + 内容系统 + 扩展体系，真实支付 E2E 验证。

### 新增（M3 商域扩展）
- **分店多租户**（ADR-004）：5 档等级自助开通（余额）、`/s/{slug}` 路径与独立域名双模式、
  分店价格链（premium 加价禁负数）、支付即时分成（等级费率）、停用 403、分店管理页
- **实物商品**（ADR-005）：地址簿、运费模板（首件+续件+满额包邮）、支付后建发货单、
  admin 物流发货推进订单
- **博客系统**（ADR-006）：文章/分类/评论（登录直显、游客审核）、浏览量冗余列、RSS、
  密码文章、admin 博客管理

### 新增（M4 视觉对标）
- 店面视觉皮肤体系落地（ADR-007）：轮播/滚动公告/公告卡/
  快捷分类/排序搜索/列表双模式/详情页/移动端适配
- 假数据全量接线（dc_options 公告、dc_sort sorticon、排序/搜索后端）
- 静态资源 no-cache 协商缓存；uploads 卷修复；GQSHOP 品牌轮播

### 新增（M5 扩展体系，ADR-008）
- **admin 权限组**：用户组权限位（`域.动作`，15 位）+ admin JWT 会话票（8h）替代全局
  key 下发；X-Admin-Key 保留机器通道；founder/未分组超管旁路
- **模板多构建**：`templates/{name}/` 一包一模板；选择链 分店指定 > front_default >
  default；内置 default 与 minimal 双模板；admin 模板管理页
- **插件系统**（进程内模型，详见 SECURITY.md 信任模型）：`@gqshop/plugin-api`
  （definePlugin/typed Hook 9 事件/异常隔离派发）+ 5 内置插件（goods 三类发货、
  epay/balance 支付清单）；active_plugins 启停；商品类型/支付通道注册表化——
  新增类型零改 core；admin 插件管理页
- **分店模板**：店主自选模板（perm_tpl 权限位），分店视图独立于主站
- **限流与锁定**：登录/注册/评论 IP 限流；admin 登录失败锁定（5 次锁 15 分钟）

### 安全（M5 前全面审计 + 修复）
- 高危×3：余额支付缺后置资金动作（统一履约 fulfillOrderAfterPaid）、已关单订单可
  余额支付致超卖、商品详情明文下发 password/pay_content（凭 id 白嫖付费内容）
- 中危×3：越权替付他人订单、提现流水对账失真、发卡与结算跨事务双发窗口
- SSRF 防线补 IPv6（环回/v4 映射/ULA/链路本地/组播）；用户/后台双端角色隔离
  （旧 token 兼容窗口收口）

## [0.2.0] - 2026-11-22

### 新增（M2 会员资金体系）
- **会员等级定价链**：8 档会员（余额购买 + level_order 流水）、member_price 覆盖 > SKU 默认价
- **余额充值**：充值卡兑换（原子核销）与提现全状态机（申请冻结 → 审核 → 打款/驳回退回，流水留痕）
- **分销佣金**：邀请码绑定（注册 superior 级联 + 自带邀请码）、佣金链入账（跳级可配 dc_options）
- **批量优惠**：三型规则（整单立减/每件立减/折扣）自动取最优；admin 配置页 + 店面提示横幅
- **售后单**：用户申请（退款/补发/其他）+ 站内沟通 + admin 回复/结单，状态机 0→1→2
- **用户中心 SPA**（apps/user，六页）：登录注册（邀请码预填）/概览/钱包/会员等级/邀请分销/我的订单
- **超时关单**：未支付订单 30 分钟自动关闭 + 库存释放 + 迟到回调恢复（jobs 定时任务）
- 邀请参数落化：店面 `?invite=` 捕获 → 注册页预填 → 绑定后清除
- 21 单测全绿

## [0.1.0] - 2026-11-21

### 新增
- **交易闭环 MVP**：游客下单 → 在线支付 → 自动发卡 → 订单查询，全链路无人工干预
- **78 表 PostgreSQL schema**：由 `tools/gen-drizzle.py` 从上游 install.sql 再生（`dc_` 前缀保留），含幂等下单增量（`dc_order.idempotency_key` 唯一索引）
- **三种卡密商品类型**：一卡一密（原子取卡 `FOR UPDATE SKIP LOCKED`）/ 通用卡密（共用卡池 + 销售留痕）/ 虚拟服务
- **支付**：易支付协议 MD5 签名 1:1 兼容（异步回调验签 + 全量回调日志 + 金额分单位校验）、余额支付（原子扣款）、staging mock 网关
- **店面**（React + Vite）：首页 / 商品详情 / 支付 / 结果（卡密展示 + 一键复制）/ 订单查询，移动端自适应
- **管理后台**（React）：仪表盘（统计 + 库存预警）/ 商品管理 / 库存导入 / 订单管理
- **认证**：注册（bcrypt）/ 登录（JWT HS256）/ 会员资料读取；历史 md5 口令迁移兼容（导入旧数据时透明重哈希）
- **CLI 无人值守安装**：迁移 + 创始人账号 + 安装锁（幂等）
- **i18n 地基**：zh-CN / en 语言包 + 文案 key 化
- **CI**：typecheck + 测试 + 78 表数量校验

### 安全
- 支付回调出站请求白名单校验（拒绝内网/环回，禁跟随重定向）
- 密钥全部走环境变量（`.env` 不入库），演示凭据不入文档
- JWT 签发修正（早期草稿曾把签名密钥误嵌 token 主体，已在首个发布版修复并轮换密钥）

### 兼容性说明
- 价格单位为"分"（integer）；`dc_user.money` 为 numeric 元
- 单规格商品对应一条 `sku='0'` 默认 SKU 行（价格全在 SKU 上）
- PHP 插件 / PHP 模板 / SG11 扩展不可直接使用（技术栈 TypeScript + Node），需按本项目插件协议重写

[0.1.0]: https://github.com/GQSHOP/gqshop-monorepo/releases/tag/v0.1.0
