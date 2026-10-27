"""
Retro Game Auto-Patcher: Local Backend (FastAPI)

Endpoints
  GET  /health
  POST /api/patch    apply registry fixes + verified byte patches
  POST /api/restore  put the .bak backup back

Safety model (the AI-generated plan is UNTRUSTED input):
  * Executable must be an absolute path whose file name is allow-listed for that game.
  * Registry writes are only allowed under allow-listed key prefixes for that game.
  * Every byte patch is verified (original / already-patched / mismatch) BEFORE anything is written.
  * A mismatch aborts the whole run before the registry or the file is touched.
  * A one-time .bak backup is made before the first write.
  * The caller must send user_confirmed=true (the UI shows a permission dialog first).
  * Binds to 127.0.0.1 only; Host header is restricted to localhost (DNS-rebinding guard).

Nothing is persisted: logs go to the console and to the HTTP response only.

Run (dev):   uvicorn main:app --host 127.0.0.1 --port 8000 --reload
Run (exe):   python main.py
"""

import hashlib
import json
import logging
import os
import re
import shutil
import sys
import threading
import webbrowser
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

import compat
import filedrop

try:
    import winreg  # Windows only
except ImportError:  # pragma: no cover
    winreg = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("patcher")

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
# CORS: by default only this app's own pages may call the patcher (the Vite dev page and the page the patcher serves itself).
# Set PATCHER_ALLOWED_ORIGINS="*" only for experiments.
DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000"
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("PATCHER_ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]
# Optional shared secret. If set, requests must send header X-Patcher-Token.
API_TOKEN = os.environ.get("PATCHER_TOKEN", "")

# Per-game allow-lists come from the shared catalog (catalog/games.json). Games that are not in the
# catalog can never be patched, no matter what a request claims.
def _load_catalog() -> Dict[str, Dict[str, Any]]:
    here = os.path.dirname(os.path.abspath(__file__))
    base = getattr(sys, "_MEIPASS", here)
    for folder in (os.path.join(base, "catalog"), os.path.join(here, "..", "catalog")):
        path = os.path.join(folder, "games.json")
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8-sig") as fh:  # tolerate a Notepad byte-order mark
                    data = json.load(fh)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"catalog/games.json is not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})")
            fixes = filedrop.load_file_fixes(folder)  # a malformed fix catalogue stops startup (fail closed)
            return {
                g["id"]: {
                    "name": g["name"],
                    "year": g.get("year", ""),
                    "blurb": g.get("blurb", ""),
                    "has_plan": bool(g.get("wiki_text")),
                    "compat": g.get("compat", {"recommended": [], "optional": []}),
                    "launch_notes": list(g.get("launch_notes", [])),
                    "exe_display": list(g["exe_names"]),
                    "exe_names": {n.lower() for n in g["exe_names"]},
                    "registry_prefixes": list(g["registry_prefixes"]),
                    "builds_sha256": [h.lower() for h in g.get("builds_sha256", [])],
                    "file_fixes": fixes.get(g["id"], {}),
                }
                for g in data["games"]
            }
    raise RuntimeError("catalog/games.json not found next to the app")


GAME_PROFILES: Dict[str, Dict[str, Any]] = _load_catalog()

ROOT_ALIASES = {
    "HKEY_CURRENT_USER": "HKEY_CURRENT_USER",
    "HKCU": "HKEY_CURRENT_USER",
    "HKEY_LOCAL_MACHINE": "HKEY_LOCAL_MACHINE",  # needs an elevated process
    "HKLM": "HKEY_LOCAL_MACHINE",
}

# ----------------------------------------------------------------------------
# RATE LIMITING: intentionally commented out (enable if this ever runs as a service)
# ----------------------------------------------------------------------------
# import time
# from collections import defaultdict, deque
# from fastapi import Request
# from fastapi.responses import JSONResponse
#
# _HITS: Dict[str, deque] = defaultdict(deque)
# RATE_LIMIT = 30          # requests
# RATE_WINDOW = 60         # seconds
#
# @app.middleware("http")
# async def rate_limit(request: Request, call_next):
#     key = request.headers.get("x-api-key") or (request.client.host if request.client else "anon")
#     now = time.monotonic()
#     hits = _HITS[key]
#     while hits and now - hits[0] > RATE_WINDOW:
#         hits.popleft()
#     if len(hits) >= RATE_LIMIT:
#         return JSONResponse({"detail": "Rate limit exceeded"}, status_code=429,
#                             headers={"Retry-After": str(RATE_WINDOW)})
#     hits.append(now)
#     return await call_next(request)
#
# For multi-process / multi-host deployments use Redis (e.g. the `slowapi` or `fastapi-limiter` packages).

# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
class RegistryFix(BaseModel):
    path: str = Field(min_length=3, max_length=500)
    name: str = Field(min_length=1, max_length=255)
    value: Union[int, str]
    type: Literal["REG_DWORD", "REG_SZ"]


class HexPatch(BaseModel):
    offset: str = Field(min_length=1, max_length=20)
    original: str = Field(min_length=2, max_length=2048)
    replace: str = Field(min_length=2, max_length=2048)


class PatchRequest(BaseModel):
    game_id: str = Field(min_length=1, max_length=64)
    target_exe: str = Field(min_length=3, max_length=500)
    registry_fixes: List[RegistryFix] = Field(default_factory=list, max_length=25)
    hex_offsets: List[HexPatch] = Field(default_factory=list, max_length=25)
    # Mirrors Settings > "Enforce .bak creation". Defaults to True so older clients stay safe.
    enforce_backup: bool = True
    user_confirmed: bool = False


class RestoreRequest(BaseModel):
    game_id: str = Field(min_length=1, max_length=64)
    target_exe: str = Field(min_length=3, max_length=500)
    user_confirmed: bool = False


class FixListRequest(BaseModel):
    game_id: str = Field(min_length=1, max_length=64)
    target_exe: str = Field(min_length=3, max_length=500)


class FixActionRequest(BaseModel):
    game_id: str = Field(min_length=1, max_length=64)
    fix_id: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    target_exe: str = Field(min_length=3, max_length=500)
    enforce_backup: bool = True
    user_confirmed: bool = False


class ScanRequest(BaseModel):
    game_id: str = Field(min_length=1, max_length=64)
    path: str = Field(min_length=3, max_length=500)


class CompatStatusRequest(BaseModel):
    target_exe: str = Field(min_length=3, max_length=500)


class CompatApplyRequest(BaseModel):
    target_exe: str = Field(min_length=3, max_length=500)
    flags: List[str] = Field(default_factory=list, max_length=8)
    user_confirmed: bool = False


class CompatRemoveRequest(BaseModel):
    target_exe: str = Field(min_length=3, max_length=500)
    user_confirmed: bool = False


class PatchError(Exception):
    """A deliberate, user-readable abort."""


class RunLog:
    """Collects log lines for the React diagnostic console."""

    def __init__(self) -> None:
        self.entries: List[Dict[str, str]] = []

    def add(self, level: str, message: str) -> None:
        self.entries.append({"level": level, "message": message, "ts": datetime.now().strftime("%H:%M:%S")})
        logger.info("[%s] %s", level, message)

    @property
    def failed(self) -> bool:
        return any(e["level"] in ("error", "abort") for e in self.entries)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def check_token(token: str) -> None:
    if API_TOKEN and token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Missing or invalid X-Patcher-Token.")


def get_profile(game_id: str) -> Dict[str, Any]:
    profile = GAME_PROFILES.get(game_id)
    if profile is None:
        raise HTTPException(status_code=400, detail=f"Unsupported game_id '{game_id}'.")
    return profile


def parse_hex_bytes(text: str, label: str) -> bytes:
    cleaned = re.sub(r"0x|[\s,]", "", text, flags=re.IGNORECASE)
    if not cleaned or len(cleaned) % 2 != 0 or not re.fullmatch(r"[0-9a-fA-F]+", cleaned):
        raise PatchError(f"{label} is not a valid even-length hex byte string: '{text}'")
    return bytes.fromhex(cleaned)


def parse_offset(text: str) -> int:
    try:
        value = int(text.strip(), 16)  # accepts '0x1A2B' and '1A2B'
    except ValueError:
        raise PatchError(f"Offset '{text}' is not valid hex.")
    if value < 0:
        raise PatchError(f"Offset '{text}' is negative.")
    return value


def resolve_exe(profile: Dict[str, Any], target_exe: str) -> str:
    raw = target_exe.strip().strip('"')
    if not os.path.isabs(raw):
        raise PatchError("Executable path must be absolute (e.g. C:\\Games\\Max Payne\\MaxPayne.exe).")
    real = os.path.realpath(raw)
    if os.path.basename(real).lower() not in profile["exe_names"]:
        allowed = ", ".join(sorted(profile["exe_names"]))
        raise PatchError(f"File name '{os.path.basename(real)}' is not allowed for this game (expected: {allowed}).")
    windir = os.environ.get("SystemRoot")
    if windir and os.path.normcase(real).startswith(os.path.normcase(os.path.realpath(windir)) + os.sep):
        raise PatchError("Refusing to modify files inside the Windows directory.")
    if not os.path.isfile(real):
        raise PatchError(f"File does not exist: {real}")
    return real


def _in_windows_dir(real: str) -> bool:
    windir = os.environ.get("SystemRoot")
    return bool(windir) and os.path.normcase(real).startswith(os.path.normcase(os.path.realpath(windir)) + os.sep)


def resolve_any_exe(target_exe: str) -> str:
    """For actions that do not depend on the catalogue (compatibility settings): an existing absolute .exe path."""
    raw = target_exe.strip().strip('"')
    if not os.path.isabs(raw):
        raise PatchError("The game path must be absolute (for example C:\\Games\\Max Payne\\MaxPayne.exe).")
    real = os.path.realpath(raw)
    if not real.lower().endswith(".exe"):
        raise PatchError("The path must point to the game's .exe file.")
    if _in_windows_dir(real):
        raise PatchError("Refusing to change settings for programs inside the Windows folder.")
    if not os.path.isfile(real):
        raise PatchError(f"File does not exist: {real}")
    return os.path.normpath(real)


_JUNK_EXE = re.compile(r"(unins|uninstall|setup|install|vcredist|redist|dxsetup|crashhandler|crashreport|updater|helper)", re.I)


def scan_for_game(profile: Dict[str, Any], path: str) -> Dict[str, Any]:
    """Finds the game's .exe from a folder (looks up to 3 levels down) or checks a .exe the user pointed at."""
    raw = path.strip().strip('"')
    if not os.path.isabs(raw):
        raise PatchError("Enter the full path, starting with a drive letter (for example C:\\Games\\Max Payne).")
    real = os.path.realpath(raw)
    if _in_windows_dir(real):
        raise PatchError("Choose your game's folder, not something inside the Windows folder.")
    names = profile["exe_names"]
    if os.path.isfile(real):
        if not real.lower().endswith(".exe"):
            raise PatchError("That file is not a program (.exe).")
        if names and os.path.basename(real).lower() not in names:
            raise PatchError(f"This game's file should be named {' or '.join(profile['exe_display'])}, not {os.path.basename(real)}.")
        return {"exe_path": os.path.normpath(real), "folder": os.path.dirname(os.path.normpath(real)), "candidates": [os.path.normpath(real)]}
    if not os.path.isdir(real):
        raise PatchError("That folder does not exist. Check the spelling, or copy the path from Explorer's address bar.")
    if os.path.dirname(real.rstrip("\\/")) == real.rstrip("\\/") or os.path.dirname(real) == real:
        raise PatchError("Choose the game's own folder, not a whole drive.")
    base_depth, found, scanned = real.rstrip(os.sep).count(os.sep), [], 0
    for folder, dirs, files in os.walk(real):
        if folder.count(os.sep) - base_depth >= 3:
            dirs[:] = []
        scanned += len(files)
        if scanned > 20000:
            break
        for f in files:
            if not f.lower().endswith(".exe"):
                continue
            if names and f.lower() in names:
                found.append(os.path.join(folder, f))
            elif not names and not _JUNK_EXE.search(f) and folder.count(os.sep) - base_depth <= 1:
                found.append(os.path.join(folder, f))
    found.sort(key=lambda p: (p.count(os.sep), p.lower()))
    if not found:
        if names:
            raise PatchError(f"Could not find {' or '.join(profile['exe_display'])} in that folder (looked up to 3 folders deep). Pick the folder that contains the game.")
        raise PatchError("Found no game program (.exe) in that folder. Pick the game's folder, or paste the full path of its .exe.")
    found = [os.path.normpath(p) for p in found[:12]]
    return {"exe_path": found[0] if (names or len(found) == 1) else None, "folder": os.path.dirname(found[0]), "candidates": found}


def split_registry_path(path: str):
    norm = path.replace("/", "\\").strip().strip("\\")
    root_name, _, subkey = norm.partition("\\")
    alias = ROOT_ALIASES.get(root_name.upper())
    if alias is None or not subkey:
        raise PatchError(f"Unsupported registry path '{path}'. Use HKEY_CURRENT_USER or HKEY_LOCAL_MACHINE.")
    return getattr(winreg, alias), alias, subkey


def subkey_allowed(subkey: str, prefixes: List[str]) -> bool:
    s = subkey.lower()
    return any(s == p.lower() or s.startswith(p.lower() + "\\") for p in prefixes)


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def backup_path(exe: str) -> str:
    return exe + ".bak"


# ----------------------------------------------------------------------------
# Hex patching
# ----------------------------------------------------------------------------
def parse_hex_plan(patches: List[HexPatch]) -> List[Dict[str, Any]]:
    parsed = []
    for i, p in enumerate(patches):
        offset = parse_offset(p.offset)
        original = parse_hex_bytes(p.original, f"hex_offsets[{i}].original")
        replace = parse_hex_bytes(p.replace, f"hex_offsets[{i}].replace")
        if len(original) != len(replace):
            raise PatchError(f"hex_offsets[{i}]: original and replace must be the same length.")
        if original == replace:
            raise PatchError(f"hex_offsets[{i}]: original and replace are identical.")
        parsed.append({"offset": offset, "original": original, "replace": replace})
    return parsed


def preflight_hex(exe: str, parsed: List[Dict[str, Any]], log: RunLog) -> Optional[List[str]]:
    """Read-only check. Returns a state per patch ('patch' | 'skip') or None on abort."""
    states: List[str] = []
    with open(exe, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        for i, p in enumerate(parsed):
            length = len(p["original"])
            if p["offset"] + length > size:
                log.add("abort", f"Patch {i + 1}: offset 0x{p['offset']:X} is beyond the end of the file ({size} bytes).")
                return None
            fh.seek(p["offset"])
            current = fh.read(length)
            if current == p["original"]:
                states.append("patch")
            elif current == p["replace"]:
                states.append("skip")
            else:
                log.add(
                    "abort",
                    f"Patch {i + 1}: bytes at 0x{p['offset']:X} are {current.hex(' ').upper()}, "
                    f"expected {p['original'].hex(' ').upper()} or {p['replace'].hex(' ').upper()}. "
                    "This is probably a different game version. Nothing was changed.",
                )
                return None
    return states


def write_hex(exe: str, parsed: List[Dict[str, Any]], states: List[str], log: RunLog, enforce_backup: bool = True) -> None:
    bak = backup_path(exe)
    if any(s == "patch" for s in states):
        if not enforce_backup:
            log.add("warn", "Backup skipped because backups are turned off in Settings. This change cannot be restored from the app.")
        elif os.path.exists(bak):
            log.add("info", f"Backup already exists, keeping the original: {bak}")
        else:
            shutil.copy2(exe, bak)
            log.add("success", f"Backup created: {bak}")
    with open(exe, "r+b") as fh:
        for i, (p, state) in enumerate(zip(parsed, states)):
            if state == "skip":
                log.add("skip", f"Patch {i + 1} at 0x{p['offset']:X}: already patched, skipped.")
                continue
            fh.seek(p["offset"])
            fh.write(p["replace"])
            fh.flush()
            log.add(
                "success",
                f"Patch {i + 1} at 0x{p['offset']:X}: {p['original'].hex(' ').upper()} -> {p['replace'].hex(' ').upper()}",
            )
        os.fsync(fh.fileno())


# ----------------------------------------------------------------------------
# Registry patching
# ----------------------------------------------------------------------------
def validate_registry(fixes: List[RegistryFix], profile: Dict[str, Any]) -> None:
    for i, fix in enumerate(fixes):
        _, _, subkey = split_registry_path(fix.path)
        if not subkey_allowed(subkey, profile["registry_prefixes"]):
            raise PatchError(f"registry_fixes[{i}]: key '{fix.path}' is outside the allowed locations for this game.")
        if fix.type == "REG_DWORD":
            try:
                n = int(fix.value)
            except (TypeError, ValueError):
                raise PatchError(f"registry_fixes[{i}]: '{fix.value}' is not a valid DWORD.")
            if not 0 <= n <= 0xFFFFFFFF:
                raise PatchError(f"registry_fixes[{i}]: DWORD out of range.")
        elif not isinstance(fix.value, str):
            raise PatchError(f"registry_fixes[{i}]: REG_SZ needs a string value.")


def apply_registry_fix(fix: RegistryFix, log: RunLog) -> None:
    root, root_name, subkey = split_registry_path(fix.path)
    reg_type = winreg.REG_DWORD if fix.type == "REG_DWORD" else winreg.REG_SZ
    value: Union[int, str] = int(fix.value) if fix.type == "REG_DWORD" else str(fix.value)
    # Retro games are usually 32-bit, so write to the 32-bit registry view.
    access = winreg.KEY_READ | winreg.KEY_WRITE | winreg.KEY_WOW64_32KEY
    label = f"{root_name}\\{subkey}\\{fix.name}"
    try:
        with winreg.CreateKeyEx(root, subkey, 0, access) as key:
            try:
                current, current_type = winreg.QueryValueEx(key, fix.name)
            except FileNotFoundError:
                current, current_type = None, None
            if current == value and current_type == reg_type:
                log.add("skip", f"{label} already {value!r}, skipped.")
                return
            winreg.SetValueEx(key, fix.name, 0, reg_type, value)
            before = "not set" if current is None else repr(current)
            log.add("success", f"{label}: {before} -> {value!r} ({fix.type})")
    except PermissionError:
        log.add("error", f"Permission denied writing {label}. HKLM keys need the app to run as administrator.")
    except OSError as exc:
        log.add("error", f"Registry error on {label}: {exc}")


# ----------------------------------------------------------------------------
# App
# ----------------------------------------------------------------------------
app = FastAPI(title="Retro Game Auto-Patcher (local)", docs_url=None, redoc_url=None)

# Order matters: CORS must be outermost so preflight (OPTIONS) always gets the headers.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=86400,
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "windows": winreg is not None}


@app.post("/api/patch")
def patch(req: PatchRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    check_token(x_patcher_token)
    log = RunLog()
    if not req.user_confirmed:
        raise HTTPException(status_code=403, detail="Permission was not granted by the user.")
    profile = get_profile(req.game_id)

    try:
        if winreg is None:
            raise PatchError("This patcher only works on Windows (the winreg module is unavailable).")

        log.add("info", f"Received plan: {len(req.registry_fixes)} registry fix(es), {len(req.hex_offsets)} byte patch(es).")
        if not req.registry_fixes and not req.hex_offsets:
            log.add("warn", "The plan is empty, nothing to do.")
            return {"success": True, "logs": log.entries}

        # 1) Validate everything first (no side effects).
        validate_registry(req.registry_fixes, profile)
        exe = None
        parsed: List[Dict[str, Any]] = []
        states: List[str] = []
        if req.hex_offsets:
            exe = resolve_exe(profile, req.target_exe)
            log.add("info", f"Target file: {exe}")
            parsed = parse_hex_plan(req.hex_offsets)
            checked = preflight_hex(exe, parsed, log)
            if checked is None:
                return {"success": False, "logs": log.entries}
            states = checked
            builds = profile["builds_sha256"]
            if not builds:
                log.add("warn", "No build hash is recorded for this game yet, so only the byte checks protect the file.")
            elif any(st == "patch" for st in states) and sha256_of(exe) not in builds:
                raise PatchError("This executable is not a known build of the game (SHA-256 mismatch). Nothing was changed.")
            log.add("info", "Byte check passed. Every location matches the expected original or patched bytes.")

        # 2) Registry.
        for fix in req.registry_fixes:
            apply_registry_fix(fix, log)

        # 3) Bytes.
        if exe is not None:
            try:
                write_hex(exe, parsed, states, log, req.enforce_backup)
            except PermissionError:
                log.add("error", "Permission denied writing the executable. Close the game and run as administrator if it is in Program Files.")
            except OSError as exc:
                log.add("error", f"File error: {exc}")

    except PatchError as exc:
        log.add("abort", str(exc))
    except Exception as exc:  # last-resort guard: never leak a stack trace to the UI
        logger.exception("Unexpected error")
        log.add("error", f"Unexpected error: {exc.__class__.__name__}")

    return {"success": not log.failed, "logs": log.entries}


@app.post("/api/restore")
def restore(req: RestoreRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    check_token(x_patcher_token)
    log = RunLog()
    if not req.user_confirmed:
        raise HTTPException(status_code=403, detail="Permission was not granted by the user.")
    profile = get_profile(req.game_id)
    try:
        exe = resolve_exe(profile, req.target_exe)
        bak = backup_path(exe)
        if not os.path.isfile(bak):
            raise PatchError(f"No backup found at {bak}.")
        shutil.copy2(bak, exe)
        log.add("success", f"Restored {exe} from backup.")
    except PatchError as exc:
        log.add("abort", str(exc))
    except PermissionError:
        log.add("error", "Permission denied. Close the game and try again (or run as administrator).")
    except OSError as exc:
        log.add("error", f"File error: {exc}")
    return {"success": not log.failed, "logs": log.entries}


# ----------------------------------------------------------------------------
# Catalogue, folder scan and compatibility settings (used by the setup window)
# ----------------------------------------------------------------------------
@app.get("/api/games")
def games_list() -> Dict[str, Any]:
    return {
        "games": [
            {
                "id": gid,
                "name": p["name"],
                "year": p["year"],
                "blurb": p["blurb"],
                "exe_names": p["exe_display"],
                "has_plan": p["has_plan"],
                "file_fixes": len(p["file_fixes"]),
                "compat": p["compat"],
                "launch_notes": p["launch_notes"],
            }
            for gid, p in GAME_PROFILES.items()
        ]
    }


@app.post("/api/scan")
def scan(req: ScanRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    check_token(x_patcher_token)
    profile = get_profile(req.game_id)
    try:
        return scan_for_game(profile, req.path)
    except PatchError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _compat_exe(target_exe: str) -> str:
    try:
        return resolve_any_exe(target_exe)
    except PatchError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/compat/status")
def compat_status(req: CompatStatusRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    check_token(x_patcher_token)
    exe = _compat_exe(req.target_exe)
    try:
        return compat.status(exe)
    except compat.CompatError as exc:
        raise HTTPException(status_code=501, detail=str(exc))


def _run_compat(token: str, confirmed: bool, target_exe: str, action) -> Dict[str, Any]:
    check_token(token)
    if not confirmed:
        raise HTTPException(status_code=403, detail="Permission was not granted by the user.")
    exe = _compat_exe(target_exe)
    log = RunLog()
    try:
        action(exe, log)
    except compat.CompatError as exc:
        log.add("abort", str(exc))
    except PermissionError:
        log.add("error", "Windows refused the change (permission denied).")
    except OSError as exc:
        log.add("error", f"Registry error: {exc}")
    except Exception as exc:  # last-resort guard: never leak a stack trace to the UI
        logger.exception("Unexpected error")
        log.add("error", f"Unexpected error: {exc.__class__.__name__}")
    return {"success": not log.failed, "logs": log.entries}


@app.post("/api/compat/apply")
def compat_apply(req: CompatApplyRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    return _run_compat(x_patcher_token, req.user_confirmed, req.target_exe, lambda exe, log: compat.apply(exe, req.flags, log))


@app.post("/api/compat/remove")
def compat_remove(req: CompatRemoveRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    return _run_compat(x_patcher_token, req.user_confirmed, req.target_exe, lambda exe, log: compat.remove(exe, log))


# ----------------------------------------------------------------------------
# File-drop fixes (reviewed files bundled inside this app; see filedrop.py)
# ----------------------------------------------------------------------------
def _fix_context(game_id: str, fix_id: Optional[str], target_exe: str):
    profile = get_profile(game_id)
    fix = None
    if fix_id is not None:
        fix = profile["file_fixes"].get(fix_id)
        if fix is None:
            raise HTTPException(status_code=400, detail=f"Unknown fix '{fix_id}' for this game.")
    try:
        exe = resolve_exe(profile, target_exe)
    except PatchError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return profile, fix, os.path.dirname(exe)


@app.post("/api/fixes/list")
def fixes_list(req: FixListRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    check_token(x_patcher_token)
    profile, _, game_dir = _fix_context(req.game_id, None, req.target_exe)
    try:
        return {"game_dir": game_dir, "fixes": [filedrop.describe(f, game_dir) for f in profile["file_fixes"].values()]}
    except filedrop.DropError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _run_fix_action(req: FixActionRequest, token: str, install: bool) -> Dict[str, Any]:
    check_token(token)
    if not req.user_confirmed:
        raise HTTPException(status_code=403, detail="Permission was not granted by the user.")
    _, fix, game_dir = _fix_context(req.game_id, req.fix_id, req.target_exe)
    log = RunLog()
    try:
        if install:
            log.add("info", f"Installing '{fix['name']}' into {game_dir}")
            filedrop.install_fix(fix, game_dir, req.enforce_backup, log)
        else:
            log.add("info", f"Removing '{fix['name']}' from {game_dir}")
            filedrop.uninstall_fix(fix, game_dir, log)
    except filedrop.DropError as exc:
        log.add("abort", str(exc))
    except PermissionError:
        log.add("error", "Permission denied. Close the game and run as administrator if it is in Program Files.")
    except OSError as exc:
        log.add("error", f"File error: {exc}")
    except Exception as exc:  # last-resort guard: never leak a stack trace to the UI
        logger.exception("Unexpected error")
        log.add("error", f"Unexpected error: {exc.__class__.__name__}")
    return {"success": not log.failed, "logs": log.entries}


@app.post("/api/fixes/install")
def fixes_install(req: FixActionRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    return _run_fix_action(req, x_patcher_token, True)


@app.post("/api/fixes/uninstall")
def fixes_uninstall(req: FixActionRequest, x_patcher_token: str = Header(default="")) -> Dict[str, Any]:
    return _run_fix_action(req, x_patcher_token, False)


# ----------------------------------------------------------------------------
# Serve the built React UI when packaged (PyInstaller puts it in ./dist)
# ----------------------------------------------------------------------------
def resource_path(relative: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, relative)


def _find_ui_dir() -> Optional[str]:
    """Packaged: ./dist inside the bundle. Dev: ../frontend/dist after `npm run build`."""
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (resource_path("dist"), os.path.join(here, "..", "frontend", "dist")):
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return os.path.abspath(candidate)
    return None


UI_DIR = _find_ui_dir()
if UI_DIR:
    app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="ui")  # must stay LAST


if __name__ == "__main__":
    import uvicorn

    if UI_DIR:
        threading.Timer(1.2, lambda: webbrowser.open("http://127.0.0.1:8000")).start()
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
