# 贡献指南（Contributing）

> 面向本仓库所有开发者（包括 AI agent）。工作流：**feature 分支 → Pull Request → CI 全绿 → squash 合并进 main**。main 分支受保护，禁止直接推送。

## 一、日常开发流程（PR 工作流）

```bash
# 1. 从最新 main 开出功能分支
git switch main && git pull
git switch -c feat/你的功能名     # 命名：feat/xxx | fix/xxx | docs/xxx | chore/xxx

# 2. 开发 + 本地自检（不过不让合）
pnpm install
pnpm -r typecheck && pnpm -r test

# 3. 提交（Conventional Commits 规范，见下）
git add -A
git commit -m "feat(core): 一句话说明改了什么"

# 4. 推分支并开 PR
git push -u origin feat/你的功能名
# 网页开 PR（base: main ← compare: feat/xxx），或用 gh CLI：
gh pr create --base main --fill

# 5. CI 通过后合并（squash 保持 main 历史干净）
gh pr merge --squash --delete-branch
```

## 二、提交信息规范（Conventional Commits）

```
<类型>(<范围>): <一句话描述>

<可选正文：为什么改/影响面>
```

类型：`feat` 新功能 · `fix` 修 bug · `docs` 文档 · `refactor` 重构 · `test` 测试 · `chore` 工程/依赖 · `perf` 性能

示例：`feat(pay): 余额支付原子扣款` / `fix(m1): epay type 从订单 pay_plugin 推导`

**破坏性变更必须先写 ADR**（`docs/adr/` 或仓库内约定位置），说明动机与迁移路径。

## 三、版本发布（维护者执行）

1. 更新 `CHANGELOG.md`（Unreleased 段落整理成新版本号 + 日期）
2. 更新各包 `package.json` 版本号
3. `git tag vX.Y.Z && git push origin vX.Y.Z`
4. `gh release create vX.Y.Z --notes-file <发布说明>`（自动挂 tag）

## 四、分支与保护规则

- `main`：保护分支。禁止直推；CI（typecheck/test/schema 校验）全绿才可合并
- `feat/*`、`fix/*`：短生命周期功能分支，合并后删除
- `release/*`：发布准备分支（需要时）

## 五、红线（任何提交不得违反）

- `.env`、密钥、演示凭据、真实账号信息一律不入库
- 不手改 `packages/db/src/schema/*.ts`（生成物，改生成器或上游 SQL 后重新生成）
- 涉及资金流的改动（订单/支付/余额/佣金）必须带单测
- 迁移文件只增不改（已发布的 SQL 迁移不可修改）

## 六、AI 协作约定

AI agent 产生的改动同样走 PR 流程；合并前由项目所有者 review diff。
CI 失败的 PR 不得合并；资金域（pay/orders/deliver/balance）改动需要所有者确认后合并。
