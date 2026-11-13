#!/usr/bin/env python3
"""Fail (exit 1) when vercel.json `env` carries anything but public names."""
import json
import sys

env = json.load(open(sys.argv[1])).get("env", {})
keys = " ".join(env.keys()).upper()
bad = [w for w in ("DATABASE", "SECRET", "PRIVATE", "TOKEN", "KEY") if w in keys]
if bad:
    print(f"secret-like vercel env keys: {bad}", file=sys.stderr)
    sys.exit(1)
