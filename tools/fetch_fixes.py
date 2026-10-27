#!/usr/bin/env python3
"""
Downloads third-party fix packs from their OFFICIAL release pages and checks them against fingerprints pinned in
catalog/file_fixes.json. Standard library only. Nothing third-party is stored in this repository: the verified files are
placed in payloads/ (git-ignored) and bundled into the .exe by build_exe.bat.

  python tools/fetch_fixes.py            download whatever is missing, verify everything, abort on any mismatch
  python tools/fetch_fixes.py --check    no network: report what is missing or different
  python tools/fetch_fixes.py --repin    accept what upstream serves NOW and rewrite the pinned fingerprints (review first!)

Why --repin exists: some authors re-upload a release in place when they update it. The normal run then stops with
"upstream changed", so a silent swap can never reach your .exe. After you have looked at the new release, --repin accepts it.
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from urllib.parse import urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CATALOG = os.path.join(ROOT, "catalog", "file_fixes.json")
PAYLOADS = os.path.join(ROOT, "payloads")
HOST_SUFFIXES = ("github.com", "githubusercontent.com")  # the download and its redirect targets must be on these hosts
MAX_ARCHIVE = 80 * 1024 * 1024


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def safe_payload_path(rel):
    if not re.fullmatch(r"[A-Za-z0-9_.\-]+(/[A-Za-z0-9_.\-]+)*", rel) or ".." in rel.split("/"):
        sys.exit(f"Unsafe payload path in the catalogue: {rel!r}")
    return os.path.join(PAYLOADS, *rel.split("/"))


def host_ok(url):
    p = urlparse(url)
    return p.scheme == "https" and any(p.hostname == s or (p.hostname or "").endswith("." + s) for s in HOST_SUFFIXES)


def download(url):
    if not host_ok(url):
        sys.exit(f"Refusing to download from {url}: only https links on {', '.join(HOST_SUFFIXES)} are allowed.")
    req = urllib.request.Request(url, headers={"User-Agent": "retro-game-auto-patcher-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        if not host_ok(resp.geturl()):
            sys.exit(f"The download was redirected to an unexpected host: {resp.geturl()}")
        data = resp.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE:
        sys.exit("The download is larger than the 80 MB safety limit.")
    return data


def present(fix):
    for f in fix["files"]:
        path = safe_payload_path(f["payload"])
        if not (os.path.isfile(path) and os.path.getsize(path) == f["size"]):
            return False
        with open(path, "rb") as fh:
            if sha256_bytes(fh.read()) != f["sha256"]:
                return False
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--repin", action="store_true")
    args = ap.parse_args()
    with open(CATALOG, "r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    problems, changed = [], False
    for game_id, fixes in data["fixes"].items():
        for fix in fixes:
            dl = fix.get("download")
            if not dl:
                continue
            label = f"{game_id}/{fix['id']}"
            if not args.repin and present(fix):
                print(f"OK       {label}: all {len(fix['files'])} files present and match their fingerprints")
                continue
            if args.check:
                problems.append(f"{label}: files missing or different (run: python tools/fetch_fixes.py)")
                continue
            print(f"Fetching {label} from {dl['url']} ...")
            blob = download(dl["url"])
            digest = sha256_bytes(blob)
            if digest != dl["sha256"]:
                if not args.repin:
                    sys.exit(f"STOP {label}: upstream changed.\n  pinned  {dl['sha256'] or '(none)'}\n  served  {digest}\n"
                             "  Look at the new release, then accept it with:  python tools/fetch_fixes.py --repin")
                dl["sha256"], dl["size"], changed = digest, len(blob), True
            try:
                zf = zipfile.ZipFile(io.BytesIO(blob))
            except zipfile.BadZipFile:
                sys.exit(f"{label}: the download is not a valid zip file.")
            for f in fix["files"]:
                try:
                    member = zf.read(f["member"])
                except KeyError:
                    sys.exit(f"{label}: '{f['member']}' is not inside the archive any more. Upstream changed its layout.")
                h = sha256_bytes(member)
                if h != f["sha256"]:
                    if not args.repin:
                        sys.exit(f"STOP {label}: {f['member']} differs from its pinned fingerprint.")
                    f["sha256"], f["size"], changed = h, len(member), True
                dest = safe_payload_path(f["payload"])
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as out:
                    out.write(member)
            print(f"  wrote {len(fix['files'])} verified files, archive {dl['sha256'][:16]}...")
    if args.repin and changed:
        with open(CATALOG, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        print("Catalogue fingerprints updated. Review the diff (git diff catalog/file_fixes.json) before committing.")
    if problems:
        print("PROBLEMS:\n  " + "\n  ".join(problems))
        sys.exit(1)


if __name__ == "__main__":
    main()
