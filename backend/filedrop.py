"""
File-drop fixes: copy REVIEWED fix files (bundled inside the app) into a game's folder, and remove them again.

Security model
  * A request only ever names a game id and a fix id. File CONTENT comes only from the payloads bundled with the app,
    never from the request, the AI, or the network.
  * Every payload is re-hashed (SHA-256) against the catalogue before anything is written.
  * Destinations must be plain relative paths inside the game folder (no "..", drive letters, or symlink escapes), with an
    allow-listed extension.
  * Existing files are backed up first (unless the user turned backups off), writes are atomic, and a failure part-way
    rolls everything back.
  * A manifest (rgap_manifest.json) in the game folder records exactly what was installed, so removal only deletes files
    that are still byte-identical to what we installed. Anything the user changed since is left alone.
"""
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

ALLOWED_EXT = {".dll", ".ini", ".asi", ".cfg", ".txt"}  # keep in sync with tools/payload_manifest.py
CODE_EXT = {".dll", ".asi"}  # these run inside the game process, so the UI warns about them
MAX_FIX_BYTES = 50 * 1024 * 1024
MANIFEST_NAME = "rgap_manifest.json"
BACKUP_SUFFIX = ".rgap-bak"
TMP_SUFFIX = ".rgap-tmp"
_ID = re.compile(r"^[a-z0-9_]{2,40}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")


class DropError(Exception):
    """A deliberate, user-readable abort."""


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------- catalogue validation
def _rel_ok(rel: Any) -> bool:
    """A safe relative path: no absolute paths, drive letters, streams, traversal, or odd characters."""
    if not isinstance(rel, str) or not rel or len(rel) > 120 or rel != rel.strip():
        return False
    if rel[0] in "/\\" or ":" in rel or re.search(r'[<>"|?*\x00-\x1f]', rel):
        return False
    parts = re.split(r"[\\/]", rel)
    return not any(p in ("", ".", "..") or p.endswith((" ", ".")) for p in parts)


def validate_fix(game_id: str, fix: Dict[str, Any]) -> None:
    where = f"file_fixes[{game_id}]"
    for key in ("id", "name", "description", "license", "source", "files"):
        if key not in fix:
            raise RuntimeError(f"{where}: missing '{key}'")
    if not isinstance(fix["id"], str) or not _ID.match(fix["id"]):
        raise RuntimeError(f"{where}: bad fix id {fix['id']!r}")
    files = fix["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= 20:
        raise RuntimeError(f"{where}/{fix['id']}: needs 1 to 20 files")
    seen, total = set(), 0
    for f in files:
        for rel_key in ("payload", "dest"):
            if not _rel_ok(f.get(rel_key)):
                raise RuntimeError(f"{where}/{fix['id']}: unsafe {rel_key} path {f.get(rel_key)!r}")
        dest = f["dest"]
        base = re.split(r"[\\/]", dest)[-1]
        if os.path.splitext(base)[1].lower() not in ALLOWED_EXT:
            raise RuntimeError(f"{where}/{fix['id']}: file type not allowed: {dest}")
        if base.lower() == MANIFEST_NAME or base.lower().endswith((BACKUP_SUFFIX, TMP_SUFFIX)):
            raise RuntimeError(f"{where}/{fix['id']}: reserved file name: {dest}")
        if not _SHA.match(str(f.get("sha256", ""))):
            raise RuntimeError(f"{where}/{fix['id']}: {dest} has no valid sha256 (run tools/payload_manifest.py)")
        if not isinstance(f.get("size"), int) or f["size"] <= 0:
            raise RuntimeError(f"{where}/{fix['id']}: {dest} has no valid size")
        key = dest.replace("\\", "/").lower()
        if key in seen:
            raise RuntimeError(f"{where}/{fix['id']}: duplicate destination {dest}")
        seen.add(key)
        total += f["size"]
    if total > MAX_FIX_BYTES:
        raise RuntimeError(f"{where}/{fix['id']}: payload larger than {MAX_FIX_BYTES} bytes")


def load_file_fixes(catalog_dir: str) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """Returns {game_id: {fix_id: fix}}. A malformed catalogue stops the app at startup (fail closed)."""
    path = os.path.join(catalog_dir, "file_fixes.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:  # utf-8-sig tolerates a Notepad byte-order mark
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"catalog/file_fixes.json is not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})")
    out: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for game_id, fixes in data.get("fixes", {}).items():
        out[game_id] = {}
        for fix in fixes:
            validate_fix(game_id, fix)
            if fix["id"] in out[game_id]:
                raise RuntimeError(f"file_fixes[{game_id}]: duplicate fix id {fix['id']}")
            out[game_id][fix["id"]] = fix
    return out


def payload_root() -> Optional[str]:
    """Packaged: ./payloads inside the bundle. Dev: ../payloads next to the backend folder."""
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (os.path.join(getattr(sys, "_MEIPASS", here), "payloads"), os.path.join(here, "..", "payloads")):
        if os.path.isdir(candidate):
            return os.path.realpath(candidate)
    return None


def _inside(child: str, parent: str) -> bool:
    c, p = os.path.normcase(os.path.realpath(child)), os.path.normcase(os.path.realpath(parent))
    return c == p or c.startswith(p + os.sep)


def _payload_path(root: str, rel: str) -> str:
    path = os.path.realpath(os.path.join(root, *rel.split("/")))
    if not _inside(path, root) or not os.path.isfile(path):
        raise DropError(f"Bundled fix file is missing: {rel}. If you run from source, fetch the fix packs first: python tools/fetch_fixes.py")
    return path


def _dest_path(game_dir: str, rel: str) -> str:
    full = os.path.join(game_dir, *re.split(r"[\\/]", rel))
    if not _inside(full, game_dir):  # realpath: also catches a symlink that points outside the game folder
        raise DropError(f"Refusing to write outside the game folder: {rel}")
    return full


# --------------------------------------------------------------------------- manifest
def _manifest_path(game_dir: str) -> str:
    return os.path.join(game_dir, MANIFEST_NAME)


def _read_manifest(game_dir: str) -> Dict[str, Any]:
    path = _manifest_path(game_dir)
    if not os.path.isfile(path):
        return {"version": 1, "fixes": {}}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or not isinstance(data.get("fixes"), dict):
            raise ValueError
        return data
    except (OSError, ValueError):
        raise DropError(f"{MANIFEST_NAME} in the game folder is unreadable. Nothing was changed.")


def _write_manifest(game_dir: str, data: Dict[str, Any]) -> None:
    path = _manifest_path(game_dir)
    if not data["fixes"]:
        if os.path.exists(path):
            os.remove(path)
        return
    tmp = path + TMP_SUFFIX
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- public API
def describe(fix: Dict[str, Any], game_dir: str) -> Dict[str, Any]:
    entry = _read_manifest(game_dir)["fixes"].get(fix["id"])
    state = "not_installed"
    if entry:
        state = "installed"
        for f in fix["files"]:
            dest = _dest_path(game_dir, f["dest"])
            if not os.path.isfile(dest) or sha256_file(dest) != f["sha256"]:
                state = "modified"
    return {
        "id": fix["id"],
        "name": fix["name"],
        "description": fix["description"],
        "license": fix["license"],
        "source": fix["source"],
        "state": state,
        "third_party": "download" in fix,
        "executable_code": any(os.path.splitext(f["dest"])[1].lower() in CODE_EXT for f in fix["files"]),
        "total_bytes": sum(f["size"] for f in fix["files"]),
        "files": [{"dest": f["dest"], "size": f["size"], "sha256": f["sha256"]} for f in fix["files"]],
    }


def install_fix(fix: Dict[str, Any], game_dir: str, enforce_backup: bool, log: Any) -> None:
    root = payload_root()
    if root is None:
        raise DropError("The bundled fix files were not found next to the app.")

    # 1) Verify everything BEFORE touching the game folder.
    work: List[Dict[str, Any]] = []
    for f in fix["files"]:
        src = _payload_path(root, f["payload"])
        if os.path.getsize(src) != f["size"] or sha256_file(src) != f["sha256"]:
            raise DropError(f"Fix file {f['payload']} failed its integrity check (corrupt or tampered). Nothing was changed.")
        dest = _dest_path(game_dir, f["dest"])
        if os.path.isdir(dest):
            raise DropError(f"{f['dest']} is a folder in the game directory. Nothing was changed.")
        exists = os.path.isfile(dest)
        same = exists and sha256_file(dest) == f["sha256"]
        work.append({"f": f, "src": src, "dest": dest, "exists": exists, "same": same})
    log.add("info", "Integrity check passed for every fix file.")

    manifest = _read_manifest(game_dir)
    prior = {x["dest"]: x.get("backup") for x in manifest["fixes"].get(fix["id"], {}).get("files", [])}
    todo = [w for w in work if not w["same"]]
    if not todo:
        for w in work:
            log.add("skip", f"{w['f']['dest']} is already in place, skipped.")
        if fix["id"] not in manifest["fixes"]:
            log.add("info", "These files were not installed by this app, so they will not be tracked or removed by it.")
        return

    # 2) Write atomically, remembering how to undo each step.
    done: List[Dict[str, Any]] = []
    records: List[Dict[str, Any]] = []
    cur_tmp: Optional[str] = None
    try:
        for w in work:
            f, dest = w["f"], w["dest"]
            if w["same"]:
                log.add("skip", f"{f['dest']} is already in place, skipped.")
                records.append({"dest": f["dest"], "sha256": f["sha256"], "backup": prior.get(f["dest"])})
                continue
            backup_made: Optional[str] = None
            previous: Optional[bytes] = None
            if w["exists"]:
                with open(dest, "rb") as fh:
                    previous = fh.read()
                bak = dest + BACKUP_SUFFIX
                if not enforce_backup:
                    log.add("warn", f"{f['dest']} exists and will be overwritten WITHOUT a backup because backups are turned off in Settings.")
                elif os.path.exists(bak):
                    log.add("info", f"A backup of {f['dest']} already exists and is kept.")
                else:
                    shutil.copy2(dest, bak)
                    backup_made = bak
                    log.add("success", f"Backed up {f['dest']} to {os.path.basename(bak)}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            tmp = cur_tmp = dest + TMP_SUFFIX
            shutil.copyfile(w["src"], tmp)
            if sha256_file(tmp) != f["sha256"]:
                os.remove(tmp)
                raise DropError(f"{f['dest']} changed while being copied. Everything was rolled back.")
            os.replace(tmp, dest)
            cur_tmp = None
            done.append({"dest": dest, "previous": previous, "backup": backup_made})
            records.append({"dest": f["dest"], "sha256": f["sha256"], "backup": backup_made or prior.get(f["dest"])})
            log.add("success", f"{'Replaced' if w['exists'] else 'Installed'} {f['dest']} ({f['size']} bytes)")
        manifest["fixes"][fix["id"]] = {"installed_at": datetime.now(timezone.utc).isoformat(), "files": records}
        _write_manifest(game_dir, manifest)
    except Exception:
        if cur_tmp and os.path.exists(cur_tmp):
            try:
                os.remove(cur_tmp)
            except OSError:
                pass
        for d in reversed(done):  # roll back everything written in this run
            try:
                if d["previous"] is not None:
                    with open(d["dest"], "wb") as fh:
                        fh.write(d["previous"])
                    if d["backup"] and os.path.exists(d["backup"]):
                        os.remove(d["backup"])
                elif os.path.exists(d["dest"]):
                    os.remove(d["dest"])
            except OSError:
                pass
        raise
    log.add("success", f"Fix installed: {fix['name']}")


def _remove_empty_dirs(game_dir: str, dests: List[str]) -> None:
    """Delete folders this fix created (for example scripts/) once they are empty. Never touches the game folder itself."""
    root = os.path.realpath(game_dir)
    for rel in dests:
        parts = re.split(r"[\\/]", rel)[:-1]
        while parts:
            folder = os.path.join(root, *parts)
            try:
                if os.path.realpath(folder) != root and _inside(folder, root):
                    os.rmdir(folder)  # only succeeds when the folder is empty
            except OSError:
                break
            parts.pop()


def uninstall_fix(fix: Dict[str, Any], game_dir: str, log: Any) -> None:
    manifest = _read_manifest(game_dir)
    entry = manifest["fixes"].get(fix["id"])
    if not entry:
        raise DropError("This fix is not recorded as installed by this app, so there is nothing to remove.")
    for rec in entry["files"]:
        dest = _dest_path(game_dir, rec["dest"])
        if not os.path.isfile(dest):
            log.add("skip", f"{rec['dest']} is already gone.")
            continue
        if sha256_file(dest) != rec["sha256"]:
            log.add("warn", f"{rec['dest']} was changed after installation, so it was left untouched.")
            continue
        bak = rec.get("backup")
        if bak and os.path.isfile(bak):
            os.replace(bak, dest)
            log.add("success", f"Restored the original {rec['dest']} from its backup.")
        else:
            os.remove(dest)
            log.add("success", f"Removed {rec['dest']}")
    del manifest["fixes"][fix["id"]]
    _write_manifest(game_dir, manifest)
    _remove_empty_dirs(game_dir, [rec["dest"] for rec in entry["files"]])
    log.add("success", f"Fix removed: {fix['name']}")
