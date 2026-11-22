# -*- coding: utf-8 -*-
"""GQSHOP 开源导出工具（v1.0 发布流程，ADR-002/C2）。

从私有 monorepo HEAD 导出开源子集到公开仓库 GQSHOP/gqshop 的本地 clone 并提交。
发布动作（push）需显式 --execute；默认只做本地导出供检查。

用法：
  python -I tools/export-opensource.py --public-dir E:\\GQSHOP\\gqshop-public [--execute]
前提：gqshop-public 目录已 clone 公开仓库且可推送。

白名单语义（附录C2）：默认导出全部 git 跟踪内容，仅排除：
  - docker-compose.server.yml（服务器专用编排，含内网拓扑语义）
  - README.md（私有开发视角；公开仓库维护自己的产品 README）
  - .github/ISSUE_TEMPLATE（内部协作约定）
  - templates/default/src/gqskin/（皮肤资产，2026-11-22 起剥离出公开版，私有仓库保留）
  - templates/default/public/gqskin/img/（品牌图）
  - templates/default/src/gqskin-patch.css（皮肤补丁，仅私有版有意义）
导出会对公开版 templates/default/src/main.tsx 剥离 gqskin 相关 import（防 build 断链）；
公开版 default 模板=无皮肤但可运行，自研样式见 templates/minimal。
导出会在公开仓库生成 MIRROR.md（镜像来源 commit 说明）。
"""
import argparse
import io
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.abspath(__file__)) or r"E:\GQSHOP\gqshop-monorepo"
REPO = os.path.dirname(REPO)
PUBLIC_DEFAULT = r"E:\GQSHOP\gqshop-public"
EXCLUDE_FILES = {"docker-compose.server.yml", "README.md", "templates/default/src/gqskin-patch.css"}
EXCLUDE_DIRS = {".github/ISSUE_TEMPLATE", "templates/default/src/gqskin", "templates/default/public/gqskin/img"}

ap = argparse.ArgumentParser()
ap.add_argument("--public-dir", default=PUBLIC_DEFAULT)
ap.add_argument("--execute", action="store_true", help="实际提交并推送公开仓库（默认仅本地导出）")
args = ap.parse_args()

# 1. 从 HEAD 打包（自然遵循 .gitignore）
r = subprocess.run(["git", "-C", REPO, "archive", "-o", os.path.join(tempfile.gettempdir(), "gq_export.tar"), "HEAD"],
                   capture_output=True, text=True, shell=False)
if r.returncode != 0:
    print("archive failed:", r.stderr); sys.exit(1)

sha = subprocess.run(["git", "-C", REPO, "rev-parse", "--short", "HEAD"],
                     capture_output=True, text=True, shell=False).stdout.strip()

# 2. 解压到临时目录并应用排除
tmp = tempfile.mkdtemp(prefix="gqshop_export_")
subprocess.run(["tar", "-xf", os.path.join(tempfile.gettempdir(), "gq_export.tar"), "-C", tmp], check=True)
for d in EXCLUDE_DIRS:
    p = os.path.join(tmp, d)
    if os.path.isdir(p):
        shutil.rmtree(p)
for f in EXCLUDE_FILES:
    p = os.path.join(tmp, f)
    if os.path.isfile(p):
        os.remove(p)

# 2.5 公开版补丁：default 模板剥离对标皮肤 import（gqskin 已排除，保留 vendor 基础库）
main_tsx = os.path.join(tmp, "templates", "default", "src", "main.tsx")
if os.path.isfile(main_tsx):
    src = io.open(main_tsx, encoding="utf-8").read()
    kept = [ln for ln in src.splitlines() if "gqskin" not in ln and "dcskin" not in ln]
    io.open(main_tsx, "w", encoding="utf-8", newline="\n").write("\n".join(kept) + "\n")

# 3. 镜像到公开仓库工作区（保留公开仓自身的门面文件）
pub = args.public_dir
if not os.path.isdir(os.path.join(pub, ".git")):
    print(f"public dir {pub} 不是 git 仓库，请先 clone GQSHOP/gqshop"); sys.exit(1)
keep = {"README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", ".gitignore"}
for root, dirs, files in os.walk(pub):
    dirs[:] = [d for d in dirs if d != ".git"]
    for f in files:
        rel = os.path.relpath(os.path.join(root, f), pub)
        if rel.replace("\\", "/") in keep or rel.startswith(".mimosa"):
            continue
        os.remove(os.path.join(root, f))
for root, dirs, files in os.walk(tmp):
    rel_root = os.path.relpath(root, tmp)
    if rel_root == ".":
        dirs[:] = [d for d in dirs if d != ".git"]
    dst_root = os.path.join(pub, rel_root) if rel_root != "." else pub
    os.makedirs(dst_root, exist_ok=True)
    for f in files:
        shutil.copy2(os.path.join(root, f), os.path.join(dst_root, f))

# 4. MIRROR 说明
io.open(os.path.join(pub, "MIRROR.md"), "w", encoding="utf-8").write(
    f"# 镜像说明\n\n本仓库内容镜像自私有 monorepo commit `{sha}`（开源子集，见 ADR-002/C2）。\n"
    f"导出时间：2026-11-22。源码许可：AGPL-3.0（见 LICENSE）。\n"
)

# 5. 提交（--execute 才推送）
def git(*a):
    return subprocess.run(["git", "-C", pub, *a], capture_output=True, text=True, shell=False)

git("add", "-A")
st = git("status", "--short")
if not st.stdout.strip():
    print("无变更，公开仓库已是最新镜像", sha)
else:
    git("commit", "-q", "-m", f"chore: mirror opensource subset of {sha} (v1.0 release pipeline)")
    print("committed in public repo:", sha)
    if args.execute:
        pr = git("push", "origin", "main")
        print("pushed:", pr.returncode == 0)
    else:
        print("（--execute 未指定：本地提交完成，未推送）")
print("export done:", tmp)
