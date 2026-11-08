#!/usr/bin/env python3
"""Lightweight documentation integrity checker (standard library only)."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parent.parent
missing = []
for file in root.rglob('*.md'):
    data = file.read_text(encoding='utf-8')
    for target in re.findall(r'\[[^]]+\]\(([^)]+)\)', data):
        if target.startswith(('https://', 'http://', '#', 'mailto:')):
            continue
        path = target.split('#', 1)[0]
        if path and not (file.parent / path).exists():
            missing.append(f'{file.relative_to(root)} -> {target}')
if missing:
    print('Broken local links:\n' + '\n'.join(missing))
    sys.exit(1)
print(f'OK: validated links across {len(list(root.rglob("*.md")))} Markdown files')
