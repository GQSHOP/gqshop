# Changelog

本项目的所有显著变更记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.4.0] - 2026-11-23

主线功能池四件套（所有者拍板全选）。

### 新增
- **等级到期降级 job**（功能池①）：`startMembersJobs`——`level>=2` 且 `level_expire_time`
  已过的用户物理归零 level（5 分钟一轮；价格链的过期掉档在下单时另行校验，本 job 使
  佣金等级门槛/用户中心展示与实际一致；`level_expire_time` 保留历史值，续费按
  max(now, oldExpire) 起算不受影响）
- **密码商品/付费内容前端流**（功能池②，M7 遗留收口）：
  - 详情 API：已购用户（uid>0 且有支付订单）放行 `password`（`bought_password`）与
    `pay_content`；新增 `has_pay_content` 锁定占位标记（`has_password` 原有）
  - 商品创建（POST /v1/admin/goods）与编辑（PATCH /v1/admin/goods/:id，扩展 M4-δ
    COALESCE 端点）支持 `password`/`pay_content`；admin 商品页「密码/付费」编辑面板
  - default/minimal 双模板：详情页 🔒 锁定/已购解锁块（密码+付费内容）；支付成功页
    回链商品页提示
- **分店级插件白名单**（功能池③，M5/M6 遗留）：`gq_options station_plugin_allow`
  （`{"<stationId>":["plugin",…]}`，缺省=全允许）；生效面=分店支付通道——
  `/v1/shop/pay-methods` 分店上下文按白名单过滤，下单校验提供插件（403 拒未开通通道）；
  `PUT /v1/admin/stations/:id/plugin-allow` + admin 分店页「白名单」编辑（空=恢复全允许）
- **高级定价层**（功能池④，上游 single_rule/cost+markup/profit_rule 的 GQSHOP 语义，默认全关）：
  - `gq_options`：`price_single_rule`+`price_single_yuan`（全场统一价，压过会员价）、
    `price_profit_rule`+`price_profit_yuan`（成本+固定利润）、`price_cost_markup`+
    `price_markup_percent`（成本加成 %）；优先级 统一价 > 会员价覆盖 > 成本规则（利润>加成）> 常规链
  - 订单计价与商品展示同规则（列表 min_price CASE 聚合 + 详情 `skus[].eff_price`，
    双模板消费 eff_price）——所见即所付
  - 管理端 `GET/PUT /v1/admin/price-rules` + admin 商品页「定价规则」面板（元单位录入）
- **分店自动升档 tryAutoUpgrade**（功能池④）：`gq_options station_auto_upgrade='y'` 总开关
  （默认关）；结算事务内按 `gq_station_level.upgrade_*` 阈值逐级爬升——
  销售额/订单数/开店天数/下级分店数（GQSHOP 无父子分店，仅阈值 0 视为达标），
  `upgrade_mode` any/all；下一档未设任何阈值=不自动升（防误升）

### 性能
- 商品列表 min_price N+1 修复（功能池①）：原每商品一条 `MIN()` 查询 → 一次
  `inArray` 聚合（drizzle `min(sql…)`）

## [1.3.2] - 2026-11-23

市场站正式运营内容：官方插件生态 + 外部插件可配置化 + 开发者文档。

### 新增
- **官方市场插件四件套**（`market/src/`，全走正式提交→auto_scan→人工审→签名发布链路上架）：
  - `seo_sitemap` 1.0.1（免费）：自动生成 `/sitemap.xml`（在售商品+已发博客 ≤1000 条）与
    `/robots.txt`；多域名/反代各自生效（尊重 `x-forwarded-proto`/`x-forwarded-host`）
  - `order_webhook` 1.0.0（免费）：`order:created`/`pay:settled`/`aftersale:created` 三事件
    webhook 推送，HMAC-SHA256 签名防伪 + 内联 SSRF 防线（仅 https/内网黑名单/禁重定向）
  - `today_snapshot` 1.0.0（免费）：仪表盘「今日快照」卡片（今日订单/GMV/待支付/待处理售后，东八区自然日）
  - `advanced_stats` 1.0.0（¥9.90 买断）：高级统计三卡（30 日商品销量 Top10 / 下单→支付转化率 / 买家复购率）
- **开发者文档站** `sites/license/docs.html`：快速开始 / plugin.json 规范 / auto_scan 披露清单 /
  PluginContext API（13 事件+注册四件套+configSchema）/ 示例代码 / 付费与 license 生命周期 / 店主接入；
  市场首页与控制台双入口
- `GET /v1/admin/plugins` 新增 `external` 数组（市场安装且激活的外部插件清单）

### 修复
- **外部（市场）插件可配置化**：`GET/PUT /v1/admin/plugins/:name/config` 原只查
  `BUILTIN_PLUGINS`（外部插件带 `configSchema` 也无法配置）——回退查已激活插件定义；
  admin SPA 插件表渲染 `external` 行（🛒 市场来源标记，可启停/可配置）
- **toggle 窄化防护**：`active_plugins` 全名单 = 内置 + `installed.json` 已装外部
  （原仅内置——启停内置插件会把外部插件挤出激活名单）；外部已装插件可启停

## [1.3.0-γ] - 2026-11-23

市场站运营台与结算（ADR-012 γ 收官：α 账号上架 + β 付费流 + γ 运营台，市场运营级三段齐）。

### 新增
- **结算落账**：`market_sales_record`——settle 时同步落账（插件按平台抽成分成，
  `GQSHOP_MARKET_PLATFORM_FEE_BPS` 基点可配默认 3000=30%；SVIP 平台自留 dev_net=0）；
  幂等（order_no 唯一约束）；β 期已结算订单部署脚本回填
- **销售报表**：`GET /api/admin/sales/summary`（总 GMV/订单数/平台收入/开发者净额 + 按插件分组）
- **结算导出**：`GET /api/admin/sales/export?month=YYYY-MM`——UTF-8 BOM CSV
  （订单/插件/开发者/域名/毛额/费/净额），运营月度人工结算对账用
- **开发者收益**：`GET /api/dev/earnings`（分成明细+汇总）
- **license 作废**：`POST /api/admin/licenses/revoke`（附理由；已装实例不回收，
  解除市场侧有效授权与同域名重购限制）；`GET /api/admin/licenses` 全量列表
- **重签（钥轮换配套）**：`POST /api/admin/licenses/reissue-all`——当前私钥重签全部有效
  license（轮换流程：宿主换钥→重启→重签→各店更新 GQSHOP_LICENSE_PUBKEY→用户重新下载）
- **下架联动**：`POST /api/admin/unpublish`——index 原子移除该插件全部版本（zip 保留；
  已装不回收；恢复=提交新版本过审）
- console 运营台：销售总览卡/CSV 导出/授权管理（作废）/重签/下架 + 开发者收益表

## [1.3.0-β] - 2026-11-23

市场站付费流（ADR-012 β：pay_order / epay 支付 / license 签发 / kernel 付费门 / SVIP）。

### 新增（市场侧 apps/license）
- **定价模型**：free / onetime（买断含升级）；开发者提交时定价，admin 可改价（POST /api/admin/price，
  改后下一版本发布时生效 paid 标记）
- **购买流**：POST /api/purchase {plugin_name, domain}（域名=licensee 绑定）→ epay 订单
  （服务端代取支付页，协议与 kernel epay 1:1 同构）→ `/api/pay/notify/epay` MD5 验签结算（幂等）
- **license 签发**：支付结算即签 `{payload, sig}`（ed25519 独立密钥对，与 MARKET 包签名钥分离）；
  payload={v,type,plugin,licensee,account,issued_at,expires_at,nonce}，canon=固定构造序 stringify；
  我的授权列表 + .lic 下载（仅本人）
- **SVIP**：POST /api/purchase/svip（按月，env 可定价）→ svip.lic 全站生效
- 防重复购买（同域名已有有效 plugin license/SVIP → 409）；免费插件购买 → 400
- schema：market_plugin 价格列 + market_pay_order + market_license（幂等迁移）

### 新增（kernel 付费门，ADR-012 A4）
- `MarketEntry.paid`（index 新字段，老 kernel 忽略——向后兼容）；发布侧随定价写入
- **installPlugin/升级：paid 包要求本地有效 license**——`data/licenses/{name}.lic` 或 `svip.lic`：
  ed25519 验签（GQSHOP_LICENSE_PUBKEY）+ licensee==本站 PUBLIC_BASE host + SVIP/过期校验；
  **已装不回收**（只挡新装/升级/重装）
- `POST /v1/admin/market/license`（plugin.manage）：粘贴导入 .lic，写入前全量复验，失败即删
- admin SPA：市场列表 💰 徽标 + 导入 license 按钮

### console.html
- 付费插件购买列表（定价/开发者/购买）+ SVIP 订阅 + 我的授权（下载 .lic）
- 开发者提交表单新增定价字段

## [1.3.0-α] - 2026-11-23

市场站运营级第一步（ADR-012 α：账号+上架闭环）。

### 新增
- **apps/license 市场站服务**（独立 Hono+pg，127.0.0.1:8102，nginx 挂 license.sc9.top `/api/`；
  `/repo` 静态分发与 market-index.json 格式**零改动**——存量 kernel 客户端无缝）
- **市场账号体系**：email+bcrypt+独立 JWT（7d）+限流+封禁位；**首个注册账号自动 admin**；
  customer 可申请 developer（附简介），admin 审批开通
- **提交与 auto_scan**：multipart zip 提交（≤2MB）；静态门=zip 结构/zip-slip/条目上限/
  plugin.json 白名单（对齐 kernel 安装期校验）/入口 `node --check` 语法/**敏感 API 使用披露清单**
  （fs/network/child_process/process.env/eval 计数附给人工审——S1 信任模型前置披露）；
  插件名先到先得；published 版本不可覆盖；自己的 rejected 可重提
- **审核发布**：admin 队列（附扫描报告）→ 批准=**服务端 ed25519 签包**（与 kernel 验签同构：
  sha256+name+version）+ 内容寻址落盘（文件名=sha256，用户输入不进路径）+ index 原子再生；
  发布前 sha256 复核（防审核期间包被换）；拒绝须附理由
- **开发者控制台** sites/license/console.html：注册/登录/申请/提交/我的提交 + admin 审核
  队列与 developer 审批；市场首页加入口
- 密钥管理：签名私钥=宿主 600 文件 ro 挂载容器 `/srv/secrets/`（不进镜像/不落库/不经 env 传路径）；
  市场库 gqshop_market 专用角色；schema.sql 部署侧 psql 应用（服务零 DDL）

## [1.2.0] - 2026-11-23

运营插件首批三件套 + 插件体系两个新扩展点。

### 新增（运营插件①②③）
- **notify_email 邮件通知**：订阅 order:created / pay:settled / aftersale:created / deliver:failed，
  SMTP 发纯文本运营邮件（nodemailer）；事件粒度开关、未配置静默跳过、改配置即读即用无需重启
- **stock_alert 库存告警 webhook**：订阅 stock:low → POST JSON（企微/飞书/钉钉机器人通用），
  `X-GQSHOP-Timestamp` + `X-GQSHOP-Signature`（HMAC-SHA256(secret, `${ts}.${body}`)）可验签防伪；
  商品级去抖（默认 1800s）；URL 过 assertPublicHttpUrl SSRF 防线
- **dashboard_cards 仪表盘卡片**：近 7 日订单趋势（按日）/ 近 30 日支付方式分布 / 最近售后 5 条
  （perm=aftersale.manage，无权限位账号不渲染）

### 新增（插件体系扩展点）
- `PluginContext.registerDashboardCard`：卡片注册（stats/list/text 三泛化形态，插件不注入前端代码）；
  聚合端点 `GET /v1/admin/dashboard/cards`（dashboard.view + 逐卡额外权限位过滤，单卡失败跳过）
- `PluginDef.configSchema`：声明式配置字段 → admin 插件页 schema 驱动配置表单；
  通用存储 `GET/PUT /v1/admin/plugins/:name/config`（plugin.manage，键白名单+类型强制+大小上限）
- 仪表盘新增「插件扩展卡片」区块（卡片失败不阻断整页）

### 修复（事件总线补发射点）
- order:created / aftersale:created / deliver:failed 此前仅声明未发射——现已接入
  （下单 COMMIT 后 / 售单落库后 / 自动发货真失败时；实物待人工与幂等重放不发）

### 安全说明
- stock_alert 出站 fetch 的 SSRF 面经三重防线收口：webhook URL 仅 https（配置门 +
  读取门）→ assertPublicHttpUrl（禁私网/保留域）→ redirect:"error"（禁重定向绕过）。
  Mimosa 因项目模型不可用将 gq_options→fetch 判为 high SSRF，经所有者裁定为
  误报放行（同 pay-epay 网关 fetch 先例，且防线更多）

## [1.1.1] - 2026-11-23

生产化收口版本：staging/prod 环境分离、弱口令轮换、X-Admin-Key 兼容开关删除。

### 移除
- **X-Admin-Key 机器通道彻底删除**（1.1.0 预告兑现）：`GQSHOP_ADMIN_KEY_CHANNEL` 开关、
  `requireAdminAuth` key 分支、`AdminAuth.via:"key"` 及权限旁路一并移除，admin 会话票（8h JWT）为唯一通道
- admin 前端删除 key 双通道存储/请求头，封面上传改走 `Authorization: Bearer`
- `GQSHOP_ADMIN_KEY` 不再是 core 启动必填；仅存消费者为 `/v1/pay/mock/confirm`
  （staging 模拟支付，`GQSHOP_PAY_MOCK=1` 才暴露；prod 不设该变量）

### 变更（部署形态）
- 新增 `docker-compose.prod.yml`：独立库 gqshop_prod/专用 DB 角色/独立 JWT 密钥/PAY_MOCK 硬编码 0/
  不注入 ADMIN_KEY/端口 8101；`docker-compose.server.yml` 定名 staging（8100）
- 应用端口全部改为 `127.0.0.1` 绑定（仅 nginx 反代可达，不对公网暴露）
- 服务器目录归位：`/opt/gqshop/m0` → `/opt/gqshop/staging`，`/opt/gqshop/prod` 投产

### 安全
- 生产 founder admin 强随机口令（install-cli 无人值守建号）；staging admin 口令同步轮换
- nginx：demo.sc9.top（公开演示站）屏蔽 `/v1/admin/*`；admin 面板仅限内网/正式域名

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
