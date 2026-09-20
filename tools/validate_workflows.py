"""Validate the JobPilot GitHub Actions workflows.

YAML 1.1 parses the bare key `on:` as the boolean True, so this script checks
for both spellings. Run: python tools/validate_workflows.py
"""

import sys

import yaml

PATHS = [".github/workflows/ci.yml", ".github/workflows/release.yml"]

failures = []

for path in PATHS:
    with open(path, encoding="utf-8") as handle:
        doc = yaml.safe_load(handle)

    print(f"OK parsed {path}")

    keys = list(doc.keys())
    triggers = [k for k in keys if k == "on" or k is True]
    if not triggers:
        failures.append(f"{path}: no `on:` trigger block")
    else:
        print(f"   trigger        : {triggers[0]} -> {doc[triggers[0]]}")

    if "jobs" not in doc:
        failures.append(f"{path}: no `jobs:` block")
    else:
        print(f"   jobs           : {sorted(str(j) for j in doc['jobs'])}")

    print(f"   permissions    : {doc.get('permissions')}")
    print(f"   concurrency    : {doc.get('concurrency')}")

    if "release.yml" in path:
        if doc.get("permissions") != {"contents": "write"}:
            failures.append(f"{path}: permissions must be exactly contents: write")
    else:
        if doc.get("permissions") != {"contents": "read"}:
            failures.append(f"{path}: permissions must be exactly contents: read")

if failures:
    print("\nFAILED:")
    for failure in failures:
        print(f"  {failure}")
    sys.exit(1)

print("\nAll workflow checks passed.")
