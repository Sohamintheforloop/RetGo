#!/usr/bin/env python3
"""
Keeps catalog/file_fixes.json and the payloads/ folder in sync. Standard library only.

  python tools/payload_manifest.py            write the SHA-256 and size of every listed payload into the catalogue
  python tools/payload_manifest.py --check    verify only (used by build_exe.bat and CI); exits 1 on any problem

The check fails when: a listed file is missing, a hash or size does not match, a file under payloads/ is NOT listed
(so nothing unreviewed can be bundled into the .exe), or a file type is not allowed.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CATALOG = os.path.join(ROOT, "catalog", "file_fixes.json")
PAYLOADS = os.path.join(ROOT, "payloads")
ALLOWED_EXT = {".dll", ".ini", ".asi", ".cfg", ".txt"}  # keep in sync with backend/filedrop.py


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_catalog():
    """Reads catalog/file_fixes.json with plain-English errors instead of a traceback."""
    if not os.path.isfile(CATALOG):
        sys.exit(
            "Cannot find catalog/file_fixes.json.\n"
            f"  Looked here: {CATALOG}\n"
            "  This tool must live inside the full project (it uses the sibling 'catalog' and 'payloads' folders).\n"
            "  Fix: unzip the latest retro-game-auto-patcher.zip into a NEW empty folder and run the command from its root\n"
            "  (the folder that contains build_exe.bat). Copying only this one file into an older folder will not work."
        )
    try:
        # utf-8-sig: Windows Notepad adds a hidden byte-order mark when saving "UTF-8"; accept it.
        with open(CATALOG, "r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        sys.exit(
            f"catalog/file_fixes.json is not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno}).\n"
            "  Common causes: a missing or extra comma, a missing quote, or a single backslash in a path (use / or \\\\)."
        )


def main():
    check = "--check" in sys.argv
    data = load_catalog()
    if not os.path.isdir(PAYLOADS):
        sys.exit(f"Cannot find the payloads folder: {PAYLOADS}\n  Unzip the latest project zip and run from its root.")
    problems, listed = [], set()
    for game_id, fixes in data["fixes"].items():
        for fix in fixes:
            for f in fix["files"]:
                rel = f["payload"]
                listed.add(rel)
                path = os.path.join(PAYLOADS, *rel.split("/"))
                if os.path.splitext(rel)[1].lower() not in ALLOWED_EXT:
                    problems.append(f"{rel}: file type not allowed")
                if not os.path.isfile(path):
                    problems.append(f"{rel}: listed but missing from payloads/")
                    continue
                digest, size = sha256_file(path), os.path.getsize(path)
                if check:
                    if f["sha256"] != digest or f["size"] != size:
                        problems.append(f"{rel}: hash/size differ from the catalogue (changed after review?)")
                else:
                    f["sha256"], f["size"] = digest, size
    for folder, _dirs, files in os.walk(PAYLOADS):
        for name in files:
            rel = os.path.relpath(os.path.join(folder, name), PAYLOADS).replace(os.sep, "/")
            if rel not in listed:
                problems.append(f"{rel}: in payloads/ but NOT listed in the catalogue (it would be bundled unreviewed)")
    if problems:
        print("PAYLOAD CHECK FAILED:\n  " + "\n  ".join(problems))
        sys.exit(1)
    if not check:
        with open(CATALOG, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        print(f"Updated {CATALOG}")
    print(f"Payload check OK: {len(listed)} file(s) listed, none unlisted.")


if __name__ == "__main__":
    main()
