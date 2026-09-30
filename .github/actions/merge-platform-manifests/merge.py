#!/usr/bin/env python3
"""Merge electron-builder update manifests from x64 and arm64 builds."""

import os
import sys
import yaml


def main():
    x64_path = os.environ.get("X64_MANIFEST", "")
    arm64_path = os.environ.get("ARM64_MANIFEST", "")
    output_dir = os.environ["OUTPUT"]
    manifest_name = os.environ["MANIFEST"]

    if not x64_path:
        print("ERROR: X64_MANIFEST not set", file=sys.stderr)
        sys.exit(1)

    with open(x64_path) as f:
        x64 = yaml.safe_load(f)

    if not arm64_path:
        # No arm64 manifest — just copy x64
        out_file = os.path.join(output_dir, manifest_name)
        with open(out_file, "w") as f:
            yaml.dump(x64, f, default_flow_style=False)
        print(f"No arm64 manifest, copied x64 to {out_file}")
        return

    with open(arm64_path) as f:
        arm64 = yaml.safe_load(f)

    # Merge: start from x64, add arm64 files
    merged = dict(x64)
    merged.pop("path", None)
    merged.pop("sha512", None)

    x64_files = x64.get("files", [])
    arm64_files = arm64.get("files", [])
    seen_urls = set()
    all_files = []
    for entry in x64_files + arm64_files:
        url = entry.get("url", "")
        if url and url not in seen_urls:
            seen_urls.add(url)
            all_files.append(entry)
    merged["files"] = all_files

    out_file = os.path.join(output_dir, manifest_name)
    with open(out_file, "w") as f:
        yaml.dump(merged, f, default_flow_style=False)
    print(f"Merged manifest written to {out_file}")
    print(f"  Total file entries: {len(all_files)}")


if __name__ == "__main__":
    main()
