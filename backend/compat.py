"""
Windows compatibility settings for one game executable: the same switches as
right-click > Properties > Compatibility (Windows XP mode, fullscreen optimizations, run as administrator, ...).

How Windows stores them: one string value per program, under the CURRENT USER only:
    HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers
    value name = the full path of the .exe,  value data = "~ FLAG1 FLAG2 ..."

Safety rules
  * Only a fixed list of known flags can be written; at most one Windows-version flag.
  * Per-user (HKCU) only: no administrator rights, no effect on other Windows accounts.
  * Flags this app does not know (set by the user or by Windows) are preserved untouched.
  * The previous value is saved under HKCU\\Software\\RetroGamePatcher\\CompatBackup, so Undo restores it exactly.
    If the user changed the setting themselves after we applied it, Undo leaves their change alone.
"""
import json
from typing import Any, Dict, List

try:
    import winreg  # Windows only
except ImportError:  # pragma: no cover
    winreg = None

LAYERS_KEY = r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
STATE_KEY = r"Software\RetroGamePatcher\CompatBackup"

OS_FLAGS = ("WINXPSP3", "WIN98", "WIN7RTM")  # only one of these can be active
OTHER_FLAGS = ("DISABLEDXMAXIMIZEDWINDOWEDMODE", "RUNASADMIN", "HIGHDPIAWARE", "640X480", "16BITCOLOR")
ALLOWED = set(OS_FLAGS) | set(OTHER_FLAGS)
ORDER = list(OS_FLAGS) + list(OTHER_FLAGS)


class CompatError(Exception):
    """A deliberate, user-readable abort."""


def _need_windows() -> None:
    if winreg is None:
        raise CompatError("Compatibility settings need Windows (the registry module is unavailable).")


def validate_flags(flags: List[str]) -> List[str]:
    if not isinstance(flags, list) or not flags:
        raise CompatError("Choose at least one compatibility option.")
    clean: List[str] = []
    for f in flags:
        if not isinstance(f, str) or f not in ALLOWED:
            raise CompatError(f"Unknown compatibility option: {f!r}.")
        if f in clean:
            raise CompatError(f"Option {f} was listed twice.")
        clean.append(f)
    if sum(1 for f in clean if f in OS_FLAGS) > 1:
        raise CompatError("Pick only one Windows-version mode (XP, 98 or 7).")
    return [f for f in ORDER if f in clean]


def parse_value(value: str) -> List[str]:
    return [t for t in value.replace("\x00", " ").split() if t != "~"]


def build_value(tokens: List[str]) -> str:
    return "~ " + " ".join(tokens)


def _read(key_path: str, name: str):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, name)
            return value if isinstance(value, str) else None
    except (FileNotFoundError, OSError):
        return None


def _write(key_path: str, name: str, value: str) -> None:
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
        winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)


def _delete(key_path: str, name: str) -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
            winreg.DeleteValue(key, name)
    except (FileNotFoundError, OSError):
        pass


def status(exe: str) -> Dict[str, Any]:
    _need_windows()
    current = _read(LAYERS_KEY, exe)
    tokens = parse_value(current) if current else []
    state = _read(STATE_KEY, exe)
    return {
        "flags": [t for t in tokens if t in ALLOWED],
        "other_settings": [t for t in tokens if t not in ALLOWED],
        "managed": state is not None,
    }


def apply(exe: str, flags: List[str], log: Any) -> None:
    _need_windows()
    wanted = validate_flags(flags)
    current = _read(LAYERS_KEY, exe)
    foreign = [t for t in (parse_value(current) if current else []) if t not in ALLOWED]  # keep settings we do not manage
    new_value = build_value(wanted + foreign)
    if current == new_value:
        log.add("skip", "These compatibility settings are already in place.")
        return
    if _read(STATE_KEY, exe) is None:  # remember the ORIGINAL value once; later applies keep it
        _write(STATE_KEY, exe, json.dumps({"had": current is not None, "value": current, "applied": new_value}))
    else:
        saved = json.loads(_read(STATE_KEY, exe) or "{}")
        saved["applied"] = new_value
        _write(STATE_KEY, exe, json.dumps(saved))
    _write(LAYERS_KEY, exe, new_value)
    log.add("success", f"Compatibility settings applied: {', '.join(wanted)}")
    if foreign:
        log.add("info", f"Kept your other existing settings: {', '.join(foreign)}")


def remove(exe: str, log: Any) -> None:
    _need_windows()
    raw = _read(STATE_KEY, exe)
    if raw is None:
        raise CompatError("This app has not changed this game's compatibility settings, so there is nothing to undo.")
    try:
        saved = json.loads(raw)
    except ValueError:
        raise CompatError("The saved backup of the old settings is unreadable. Nothing was changed.")
    current = _read(LAYERS_KEY, exe)
    if current != saved.get("applied"):
        log.add("warn", "The compatibility settings were changed after this app applied them, so they were left as they are.")
    elif saved.get("had") and saved.get("value") is not None:
        _write(LAYERS_KEY, exe, saved["value"])
        log.add("success", "Restored the compatibility settings this game had before.")
    else:
        _delete(LAYERS_KEY, exe)
        log.add("success", "Removed the compatibility settings. Windows treats the game as it did originally.")
    _delete(STATE_KEY, exe)
