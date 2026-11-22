# -*- coding: utf-8 -*-
"""域间 import 硬规则检查（ADR-010 R2）：packages/domains/{A} 不得 import @gqshop/domain-{B}。
允许：@gqshop/kernel / @gqshop/db / @gqshop/plugin-api。apps/core 装配层不受限。
用法：python -I tools/check-domain-imports.py（违规列出并 exit 1）"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMAINS_DIR = os.path.join(ROOT, "packages", "domains")

violations = []
for name in os.listdir(DOMAINS_DIR):
    d = os.path.join(DOMAINS_DIR, name)
    if not os.path.isdir(d):
        continue
    for root, _dirs, files in os.walk(d):
        for f in files:
            if not f.endswith(".ts"):
                continue
            p = os.path.join(root, f)
            src = open(p, encoding="utf-8").read()
            for m in re.finditer(r"from\s+\"(@gqshop/domain-[a-z]+)\"", src):
                if m.group(1) != f"@gqshop/domain-{name}":
                    violations.append(f"{os.path.relpath(p, ROOT)} -> {m.group(1)}")

if violations:
    print("CROSS-DOMAIN IMPORT VIOLATIONS (ADR-010 R2):")
    for v in violations:
        print("  " + v)
    sys.exit(1)
print("domain import check: OK (0 violations)")
