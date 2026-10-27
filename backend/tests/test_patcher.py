"""
Tests for the local patcher. They run on any OS: a tiny in-memory stand-in replaces `winreg`, and every file lives in a
temporary folder. Run from the backend folder:   python tests/test_patcher.py     (needs: pip install -r requirements-dev.txt)
"""
import hashlib
import os
import sys
import tempfile
import types

# --- in-memory stand-in for the Windows registry -------------------------------------------------------------
REG = {}
winreg = types.ModuleType("winreg")
for _name, _val in dict(HKEY_CURRENT_USER=1, HKEY_LOCAL_MACHINE=2, KEY_READ=1, KEY_WRITE=2, KEY_WOW64_32KEY=512, REG_DWORD=4, REG_SZ=1).items():
    setattr(winreg, _name, _val)


class _Key:
    def __init__(self, root, sub):
        self.k = (root, sub.lower())

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _query(key, name):
    if (key.k, name) not in REG:
        raise FileNotFoundError
    return REG[(key.k, name)]


def _delete_value(key, name):
    if (key.k, name) not in REG:
        raise FileNotFoundError
    del REG[(key.k, name)]


winreg.CreateKeyEx = lambda root, sub, res, acc: _Key(root, sub)
winreg.OpenKey = lambda root, sub, res=0, acc=0: _Key(root, sub)
winreg.DeleteValue = _delete_value
winreg.QueryValueEx = _query
winreg.SetValueEx = lambda key, name, res, typ, val: REG.__setitem__((key.k, name), (val, typ))
sys.modules["winreg"] = winreg

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app, base_url="http://127.0.0.1:8000")
failures = 0


def check(name, cond):
    global failures
    failures += 0 if cond else 1
    print(("PASS " if cond else "FAIL ") + name)


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def write(path, data):
    with open(path, "wb") as fh:
        fh.write(data)


with tempfile.TemporaryDirectory() as tmp:
    exe = os.path.join(tmp, "DemoGame.exe")
    pristine = bytearray((i * 37 + 11) & 255 for i in range(256))
    pristine[0x10:0x14] = bytes.fromhex("74059090")
    pristine = bytes(pristine)

    def reset():
        for f in (exe, exe + ".bak"):
            if os.path.exists(f):
                os.remove(f)
        write(exe, pristine)

    key = "HKEY_CURRENT_USER\\SOFTWARE\\RetroPatcherDemo\\DemoGame"
    plan = dict(
        game_id="demo_game", target_exe=exe, user_confirmed=True,
        registry_fixes=[dict(path=key, name="ForceSingleCore", value=1, type="REG_DWORD")],
        hex_offsets=[dict(offset="0x10", original="74 05 90 90", replace="EB 05 90 90")],
    )
    main.GAME_PROFILES["demo_game"]["builds_sha256"] = []

    reset()
    check("refuses without permission (403)", client.post("/api/patch", json={**plan, "user_confirmed": False}).status_code == 403)
    r = client.post("/api/patch", json=plan)
    check("patch applied", r.json()["success"] and read(exe)[0x10:0x14].hex() == "eb059090")
    check("backup is the pristine original", read(exe + ".bak") == pristine)
    check("only the target byte changed", sum(a != b for a, b in zip(read(exe), pristine)) == 1)
    check("registry value written", REG[(((1, "software\\retropatcherdemo\\demogame")), "ForceSingleCore")] == (1, 4))
    r = client.post("/api/patch", json=plan)
    check("2nd run: everything skipped", r.json()["success"] and sum(l["level"] == "skip" for l in r.json()["logs"]) == 2)

    data = bytearray(read(exe))
    data[0x10] = 0x55
    write(exe, bytes(data))
    snap = read(exe)
    r = client.post("/api/patch", json=plan)
    check("different game version -> ABORT, file untouched", (not r.json()["success"]) and read(exe) == snap)

    bad = dict(plan, hex_offsets=[], registry_fixes=[dict(path="HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\evil", name="Start", value=0, type="REG_DWORD")])
    check("registry outside allow-list refused", "outside the allowed" in client.post("/api/patch", json=bad).text)
    check("wrong exe name refused", not client.post("/api/patch", json=dict(plan, target_exe=os.path.join(tmp, "notepad.exe"))).json()["success"])
    check("unknown game refused (400)", client.post("/api/patch", json=dict(plan, game_id="custom_123")).status_code == 400)
    check("relative path refused", not client.post("/api/patch", json=dict(plan, target_exe="game/DemoGame.exe")).json()["success"])

    reset()
    client.post("/api/patch", json=plan)
    r = client.post("/api/restore", json=dict(game_id="demo_game", target_exe=exe, user_confirmed=True))
    check("restore from .bak", r.json()["success"] and read(exe) == pristine)
    check("DNS-rebinding host blocked", client.get("/health", headers={"Host": "evil.com"}).status_code == 400)
    evil = client.options("/api/patch", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"})
    check("CORS: a random website is NOT allowed to call the patcher", "access-control-allow-origin" not in evil.headers)
    ok_origin = client.options("/api/patch", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
    check("CORS: the app's own page is allowed", ok_origin.headers.get("access-control-allow-origin") == "http://localhost:5173")

    reset()
    main.GAME_PROFILES["demo_game"]["builds_sha256"] = ["0" * 64]
    r = client.post("/api/patch", json=plan)
    check("unknown build hash -> ABORT before writing", not r.json()["success"] and read(exe) == pristine)
    main.GAME_PROFILES["demo_game"]["builds_sha256"] = [hashlib.sha256(pristine).hexdigest()]
    check("known build hash -> allowed", client.post("/api/patch", json=plan).json()["success"])
    main.GAME_PROFILES["demo_game"]["builds_sha256"] = []

    reset()
    r = client.post("/api/patch", json=dict(plan, enforce_backup=False))
    check("backups OFF: patched, no .bak, warning logged", r.json()["success"] and not os.path.exists(exe + ".bak") and any("Backup skipped" in l["message"] for l in r.json()["logs"]))
    reset()
    check("backups ON when the field is omitted", client.post("/api/patch", json=plan).json()["success"] and os.path.exists(exe + ".bak"))


# =============================== file-drop fixes ===============================
import filedrop  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    gdir = os.path.join(tmp, "game")
    os.makedirs(gdir)
    gexe = os.path.join(gdir, "DemoGame.exe")
    write(gexe, b"MZ" + b"\0" * 100)
    base = dict(game_id="demo_game", fix_id="demo_config", target_exe=gexe)
    ini, txt = os.path.join(gdir, "rgap_demo.ini"), os.path.join(gdir, "rgap_demo_readme.txt")

    def listing():
        return client.post("/api/fixes/list", json=dict(game_id="demo_game", target_exe=gexe)).json()["fixes"][0]

    f = listing()
    check("fixes/list: not installed, 2 files, no executable code", f["state"] == "not_installed" and len(f["files"]) == 2 and not f["executable_code"])
    check("fixes/install without permission -> 403", client.post("/api/fixes/install", json=base).status_code == 403)
    r = client.post("/api/fixes/install", json=dict(base, user_confirmed=True))
    check("fixes/install copies both verified files + manifest", r.json()["success"] and os.path.isfile(ini) and os.path.isfile(txt) and os.path.isfile(os.path.join(gdir, "rgap_manifest.json")))
    check("installed file is byte-identical to the reviewed payload", filedrop.sha256_file(ini) == f["files"][0]["sha256"])
    check("fixes/list now reports installed", listing()["state"] == "installed")
    r = client.post("/api/fixes/install", json=dict(base, user_confirmed=True))
    check("installing twice skips everything", r.json()["success"] and sum(l["level"] == "skip" for l in r.json()["logs"]) == 2)
    r = client.post("/api/fixes/uninstall", json=dict(base, user_confirmed=True))
    check("uninstall removes exactly what was installed (incl. manifest)", r.json()["success"] and not os.path.exists(ini) and not os.path.exists(txt) and not os.path.exists(os.path.join(gdir, "rgap_manifest.json")))
    check("uninstall when nothing installed -> clean abort", not client.post("/api/fixes/uninstall", json=dict(base, user_confirmed=True)).json()["success"])

    # existing file: backed up, then restored on uninstall
    write(ini, b"MY ORIGINAL SETTINGS")
    r = client.post("/api/fixes/install", json=dict(base, user_confirmed=True))
    check("existing file is backed up before overwrite", r.json()["success"] and read(ini + ".rgap-bak") == b"MY ORIGINAL SETTINGS" and read(ini) != b"MY ORIGINAL SETTINGS")
    client.post("/api/fixes/uninstall", json=dict(base, user_confirmed=True))
    check("uninstall restores the original file and removes the backup", read(ini) == b"MY ORIGINAL SETTINGS" and not os.path.exists(ini + ".rgap-bak") and not os.path.exists(txt))
    os.remove(ini)

    # a file the user changed after install is never deleted
    client.post("/api/fixes/install", json=dict(base, user_confirmed=True))
    write(ini, b"I EDITED THIS")
    check("list reports 'modified' when a file changed", listing()["state"] == "modified")
    r = client.post("/api/fixes/uninstall", json=dict(base, user_confirmed=True))
    check("uninstall leaves a user-modified file untouched (warns)", read(ini) == b"I EDITED THIS" and any(l["level"] == "warn" for l in r.json()["logs"]) and not os.path.exists(txt))
    os.remove(ini)

    # backups OFF
    write(ini, b"OLD")
    r = client.post("/api/fixes/install", json=dict(base, user_confirmed=True, enforce_backup=False))
    check("backups OFF: overwrites with a warning and makes no backup", r.json()["success"] and not os.path.exists(ini + ".rgap-bak") and any("WITHOUT a backup" in l["message"] for l in r.json()["logs"]))
    client.post("/api/fixes/uninstall", json=dict(base, user_confirmed=True))
    for p_ in (ini, txt):
        if os.path.exists(p_):
            os.remove(p_)

    # tampered payload (catalogue hash no longer matches) -> nothing written
    fix = main.GAME_PROFILES["demo_game"]["file_fixes"]["demo_config"]
    good = fix["files"][1]["sha256"]
    fix["files"][1]["sha256"] = "0" * 64
    r = client.post("/api/fixes/install", json=dict(base, user_confirmed=True))
    check("tampered/corrupt payload -> ABORT, game folder untouched", not r.json()["success"] and not os.path.exists(ini) and not os.path.exists(txt) and "integrity" in r.text)
    fix["files"][1]["sha256"] = good

    # failure half-way -> full rollback (simulate the 2nd atomic replace failing)
    write(ini, b"KEEP ME")
    real_replace, calls = os.replace, {"n": 0}

    def flaky(a, b):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("simulated disk error")
        return real_replace(a, b)

    os.replace = flaky
    try:
        r = client.post("/api/fixes/install", json=dict(base, user_confirmed=True))
    finally:
        os.replace = real_replace
    left = sorted(os.listdir(gdir))
    check("failure mid-install rolls back: original restored, no backup/tmp/manifest left", (not r.json()["success"]) and read(ini) == b"KEEP ME" and left == ["DemoGame.exe", "rgap_demo.ini"])
    os.remove(ini)

    # request validation
    check("unknown fix id -> 400", client.post("/api/fixes/install", json=dict(base, fix_id="nope", user_confirmed=True)).status_code == 400)
    check("game with no file fixes -> 400", client.post("/api/fixes/install", json=dict(base, game_id="stalker", user_confirmed=True)).status_code == 400)
    wrong = os.path.join(gdir, "notepad.exe")
    write(wrong, b"MZ")
    check("wrong executable name -> 400", client.post("/api/fixes/list", json=dict(game_id="demo_game", target_exe=wrong)).status_code == 400)
    check("fix id with path characters rejected (422)", client.post("/api/fixes/install", json=dict(base, fix_id="../../x", user_confirmed=True)).status_code == 422)

    # catalogue validation: unsafe fixes can never load
    def bad(**over):
        file_ = {"payload": "demo_game/demo_config/rgap_demo.ini", "dest": "rgap_demo.ini", "sha256": "a" * 64, "size": 5}
        file_.update(over)
        return dict(id="x_fix", name="n", description="d", license="l", source="s", files=[file_])

    def rejected(fix_):
        try:
            filedrop.validate_fix("demo_game", fix_)
            return False
        except RuntimeError:
            return True

    cases = [dict(dest="..\\evil.dll"), dict(dest="../evil.dll"), dict(dest="C:\\evil.dll"), dict(dest="/etc/x.ini"), dict(dest="a.exe"), dict(dest="run.bat"),
             dict(dest="rgap_manifest.json"), dict(dest="x.ini.rgap-bak"), dict(dest="sub/../x.ini"), dict(dest="x.ini:stream.txt"), dict(payload="../../secret.ini"), dict(sha256="zz"), dict(size=0)]
    check("catalogue rejects unsafe destinations / payloads / hashes (%d cases)" % len(cases), all(rejected(bad(**c)) for c in cases))
    dup = bad()
    dup["files"].append(dict(dup["files"][0], payload="demo_game/demo_config/rgap_demo_readme.txt"))
    check("catalogue rejects duplicate destinations", rejected(dup))

    # symlink escape
    outside = os.path.join(tmp, "outside")
    os.makedirs(outside)
    try:
        os.symlink(outside, os.path.join(gdir, "sub"), target_is_directory=True)
        evil = bad(dest="sub/escape.ini")
        evil["files"][0]["sha256"] = filedrop.sha256_file(os.path.join(filedrop.payload_root(), "demo_game", "demo_config", "rgap_demo.ini"))
        evil["files"][0]["size"] = os.path.getsize(os.path.join(filedrop.payload_root(), "demo_game", "demo_config", "rgap_demo.ini"))

        class _L:
            def add(self, *a):
                pass

        try:
            filedrop.install_fix(evil, gdir, True, _L())
            escaped = True
        except filedrop.DropError:
            escaped = False
        check("symlink pointing outside the game folder is refused", (not escaped) and not os.path.exists(os.path.join(outside, "escape.ini")))
    except (OSError, NotImplementedError):
        print("SKIP symlink test (no symlink permission on this machine)")



# ===================== catalogue, folder scan, compatibility settings, real fix pack =====================
def _raises_patch_error(fn):
    try:
        fn()
        return False
    except main.PatchError:
        return True


import compat  # noqa: E402

g = client.get("/api/games").json()["games"]
byid = {x["id"]: x for x in g}
check("/api/games lists the catalogue with setup info", {"max_payne", "max_payne_2", "stalker", "other_game", "demo_game"} <= set(byid))
check("real games carry NO fictional byte patch; the demo game does", byid["max_payne"]["has_plan"] is False and byid["demo_game"]["has_plan"] is True)
check("Max Payne offers the fix pack and recommended compatibility", byid["max_payne"]["file_fixes"] == 1 and "DISABLEDXMAXIMIZEDWINDOWEDMODE" in byid["max_payne"]["compat"]["recommended"] and byid["max_payne"]["launch_notes"])

with tempfile.TemporaryDirectory() as tmp:
    def mk(*parts):
        path = os.path.join(tmp, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write(path, b"MZ")
        return path

    def scan(game, path):
        return client.post("/api/scan", json=dict(game_id=game, path=path))

    mp = mk("Max Payne", "MaxPayne.exe")
    r = scan("max_payne", os.path.dirname(mp))
    check("scan: finds MaxPayne.exe from the game folder", r.status_code == 200 and r.json()["exe_path"] == mp)
    check("scan: accepts the .exe path itself", scan("max_payne", mp).json()["exe_path"] == mp)
    st = mk("STALKER", "bin", "xr_3DA.exe")
    check("scan: finds an exe one folder down (STALKER bin)", scan("stalker", os.path.join(tmp, "STALKER")).json()["exe_path"] == st)
    deep = mk("d", "a", "b", "c", "e", "MaxPayne.exe")
    check("scan: does not wander more than 3 levels deep", scan("max_payne", os.path.join(tmp, "d")).status_code == 400)
    other = mk("Wrong", "notmaxpayne.exe")
    check("scan: wrong file name is refused with a helpful message", scan("max_payne", other).status_code == 400 and "MaxPayne.exe" in scan("max_payne", other).text)
    check("scan: empty folder -> clear error", scan("max_payne", os.path.join(tmp, "Wrong")).status_code == 400)
    check("scan: folder that does not exist -> 400", scan("max_payne", os.path.join(tmp, "nope")).status_code == 400)
    check("scan: relative path -> 400", scan("max_payne", "Games/MP").status_code == 400)
    check("scan: a whole drive/root is refused", scan("max_payne", os.path.abspath(os.sep)).status_code in (400, 422))
    check("scan: the guard itself rejects a drive root", _raises_patch_error(lambda: main.scan_for_game(main.GAME_PROFILES["max_payne"], os.path.abspath(os.sep))))
    check("scan: unknown game -> 400", scan("nope", mp).status_code == 400)
    mk("Misc", "Game.exe"); mk("Misc", "unins000.exe"); mk("Misc", "vcredist_x86.exe")
    r = scan("other_game", os.path.join(tmp, "Misc")).json()
    check("scan (other game): ignores installers, offers the real exe", [os.path.basename(c) for c in r["candidates"]] == ["Game.exe"] and r["exe_path"].endswith("Game.exe"))
    mk("Misc2", "A.exe"); mk("Misc2", "B.exe")
    r = scan("other_game", os.path.join(tmp, "Misc2")).json()
    check("scan (other game): several exes -> user must choose (no guess)", r["exe_path"] is None and len(r["candidates"]) == 2)

    # ---- compatibility settings ----
    exe = mk("Compat", "Game.exe")
    body = dict(target_exe=exe)
    check("compat/status: nothing set yet", client.post("/api/compat/status", json=body).json() == {"flags": [], "other_settings": [], "managed": False})
    check("compat/apply without permission -> 403", client.post("/api/compat/apply", json=dict(body, flags=["WINXPSP3"])).status_code == 403)
    r = client.post("/api/compat/apply", json=dict(body, flags=["DISABLEDXMAXIMIZEDWINDOWEDMODE", "WINXPSP3"], user_confirmed=True))
    key = ((1, "software\\microsoft\\windows nt\\currentversion\\appcompatflags\\layers"), os.path.normpath(exe))
    check("compat/apply writes the right value (OS flag first, ~ prefix)", r.json()["success"] and REG[key][0] == "~ WINXPSP3 DISABLEDXMAXIMIZEDWINDOWEDMODE")
    check("compat/status reports what is set", client.post("/api/compat/status", json=body).json() == {"flags": ["WINXPSP3", "DISABLEDXMAXIMIZEDWINDOWEDMODE"], "other_settings": [], "managed": True})
    r = client.post("/api/compat/apply", json=dict(body, flags=["DISABLEDXMAXIMIZEDWINDOWEDMODE", "WINXPSP3"], user_confirmed=True))
    check("compat/apply twice -> skipped", r.json()["success"] and r.json()["logs"][-1]["level"] == "skip")
    r = client.post("/api/compat/remove", json=dict(body, user_confirmed=True))
    check("compat/remove deletes the value when there was none before", r.json()["success"] and key not in REG and client.post("/api/compat/status", json=body).json()["managed"] is False)
    check("compat/remove when nothing was applied -> clean abort", not client.post("/api/compat/remove", json=dict(body, user_confirmed=True)).json()["success"])

    # a value the user already had: unknown settings are preserved, the original comes back on undo
    REG[key] = ("~ WIN98 SOMEOTHERFLAG", 1)
    client.post("/api/compat/apply", json=dict(body, flags=["WIN7RTM", "RUNASADMIN"], user_confirmed=True))
    check("compat/apply keeps settings it does not manage", REG[key][0] == "~ WIN7RTM RUNASADMIN SOMEOTHERFLAG")
    client.post("/api/compat/apply", json=dict(body, flags=["WIN7RTM"], user_confirmed=True))  # a second apply must not lose the ORIGINAL backup
    client.post("/api/compat/remove", json=dict(body, user_confirmed=True))
    check("compat/remove restores the user's ORIGINAL value exactly", REG[key][0] == "~ WIN98 SOMEOTHERFLAG")
    REG.pop(key, None)

    # the user changes it themselves after we applied -> undo leaves their change
    client.post("/api/compat/apply", json=dict(body, flags=["RUNASADMIN"], user_confirmed=True))
    REG[key] = ("~ HIGHDPIAWARE", 1)
    r = client.post("/api/compat/remove", json=dict(body, user_confirmed=True))
    check("compat/remove never overwrites a change the user made later (warns)", REG[key][0] == "~ HIGHDPIAWARE" and any(l["level"] == "warn" for l in r.json()["logs"]))
    REG.pop(key, None)

    for bad_flags, why in (([], "empty"), (["NOPE"], "unknown flag"), (["WINXPSP3", "WIN98"], "two Windows modes"), (["RUNASADMIN", "RUNASADMIN"], "duplicate"), (["~ RUNASADMIN"], "injection attempt")):
        r = client.post("/api/compat/apply", json=dict(body, flags=bad_flags, user_confirmed=True))
        check(f"compat rejects {why}", not r.json()["success"] and key not in REG)
    check("compat: relative path -> 400", client.post("/api/compat/status", json=dict(target_exe="Game.exe")).status_code == 400)
    check("compat: non-exe -> 400", client.post("/api/compat/status", json=dict(target_exe=os.path.join(tmp, "Compat", "x.txt"))).status_code == 400)
    check("compat: missing file -> 400", client.post("/api/compat/status", json=dict(target_exe=os.path.join(tmp, "Compat", "ghost.exe"))).status_code == 400)
    fake_win = os.path.join(tmp, "Windows")
    sysexe = mk("Windows", "System32", "notepad.exe")
    os.environ["SystemRoot"] = fake_win
    try:
        check("compat: programs inside the Windows folder are refused", client.post("/api/compat/status", json=dict(target_exe=sysexe)).status_code == 400)
    finally:
        del os.environ["SystemRoot"]

    # ---- the REAL Max Payne fix pack (fetched by tools/fetch_fixes.py): install, overwrite-with-backup, remove ----
    root = filedrop.payload_root()
    if root is None or not os.path.isdir(os.path.join(root, "max_payne", "modern_pack")):
        print("SKIP real fix-pack test (run: python tools/fetch_fixes.py)")
    else:
        gdir = os.path.join(tmp, "Real MP")
        os.makedirs(gdir)
        mpexe = os.path.join(gdir, "MaxPayne.exe")
        write(mpexe, b"MZ")
        write(os.path.join(gdir, "dsound.dll"), b"ORIGINAL SYSTEM-STYLE DLL")
        info = client.post("/api/fixes/list", json=dict(game_id="max_payne", target_exe=mpexe)).json()["fixes"][0]
        check("real pack: listed as third-party, adds program files, 12 files", info["third_party"] and info["executable_code"] and len(info["files"]) == 12)
        r = client.post("/api/fixes/install", json=dict(game_id="max_payne", fix_id="modern_pack", target_exe=mpexe, user_confirmed=True))
        names = sorted(os.listdir(gdir))
        check("real pack: installs all 12 files incl. the scripts folder", r.json()["success"] and os.path.isfile(os.path.join(gdir, "scripts", "MaxPayne.WidescreenFix.asi")) and "dinput.dll" in names and "Xidi.32.dll" in names)
        check("real pack: every installed file matches its pinned fingerprint", all(filedrop.sha256_file(os.path.join(gdir, *f["dest"].split("/"))) == f["sha256"] for f in info["files"]))
        check("real pack: the existing dsound.dll was backed up first", read(os.path.join(gdir, "dsound.dll.rgap-bak")) == b"ORIGINAL SYSTEM-STYLE DLL")
        client.post("/api/fixes/uninstall", json=dict(game_id="max_payne", fix_id="modern_pack", target_exe=mpexe, user_confirmed=True))
        check("real pack: removal leaves the game folder exactly as it was (no empty scripts folder either)", sorted(os.listdir(gdir)) == ["MaxPayne.exe", "dsound.dll"] and read(os.path.join(gdir, "dsound.dll")) == b"ORIGINAL SYSTEM-STYLE DLL")
        # a folder that already held the user's own files is kept
        os.makedirs(os.path.join(gdir, "scripts"))
        write(os.path.join(gdir, "scripts", "my_own_mod.asi"), b"MINE")
        client.post("/api/fixes/install", json=dict(game_id="max_payne", fix_id="modern_pack", target_exe=mpexe, user_confirmed=True))
        client.post("/api/fixes/uninstall", json=dict(game_id="max_payne", fix_id="modern_pack", target_exe=mpexe, user_confirmed=True))
        check("real pack: removal keeps a folder that still holds the user's own files", os.listdir(os.path.join(gdir, "scripts")) == ["my_own_mod.asi"])

# ========================= catalogue / tool robustness (Windows editors) =========================
import json as _json  # noqa: E402
import shutil as _shutil  # noqa: E402
import subprocess as _sp  # noqa: E402

_root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
with tempfile.TemporaryDirectory() as tmp:
    cat = os.path.join(tmp, "catalog")
    os.makedirs(cat)
    good = read(os.path.join(_root, "catalog", "file_fixes.json"))
    write(os.path.join(cat, "file_fixes.json"), b"\xef\xbb\xbf" + good)  # as saved by Windows Notepad
    check("app loads a catalogue saved with a UTF-8 byte-order mark", "demo_game" in filedrop.load_file_fixes(cat))
    write(os.path.join(cat, "file_fixes.json"), b'{"fixes": {,}}')
    try:
        filedrop.load_file_fixes(cat)
        msg = ""
    except RuntimeError as exc:
        msg = str(exc)
    check("malformed catalogue -> plain error naming the file, line and column", "file_fixes.json is not valid JSON" in msg and "line 1" in msg)

with tempfile.TemporaryDirectory() as tmp:  # a project folder that has the tool but NOT the catalogue (the reported crash)
    os.makedirs(os.path.join(tmp, "tools"))
    _shutil.copy(os.path.join(_root, "tools", "payload_manifest.py"), os.path.join(tmp, "tools"))
    r = _sp.run([sys.executable, os.path.join(tmp, "tools", "payload_manifest.py"), "--check"], capture_output=True, text=True)
    check("payload tool without the catalogue: clear message, no traceback", r.returncode != 0 and "Cannot find catalog/file_fixes.json" in r.stderr and "Traceback" not in r.stderr)

with tempfile.TemporaryDirectory() as tmp:  # BOM + a real project layout
    _shutil.copytree(os.path.join(_root, "tools"), os.path.join(tmp, "tools"))
    _shutil.copytree(os.path.join(_root, "payloads"), os.path.join(tmp, "payloads"))
    os.makedirs(os.path.join(tmp, "catalog"))
    write(os.path.join(tmp, "catalog", "file_fixes.json"), b"\xef\xbb\xbf" + read(os.path.join(_root, "catalog", "file_fixes.json")))
    r = _sp.run([sys.executable, os.path.join(tmp, "tools", "payload_manifest.py"), "--check"], capture_output=True, text=True)
    check("payload tool accepts a catalogue with a byte-order mark", r.returncode == 0 and "Payload check OK" in r.stdout)
    write(os.path.join(tmp, "catalog", "file_fixes.json"), b'{"fixes": {"demo_game": [ {"id": "x" "name": 1} ]}}')
    r = _sp.run([sys.executable, os.path.join(tmp, "tools", "payload_manifest.py"), "--check"], capture_output=True, text=True)
    check("payload tool with a typo in the catalogue: plain JSON error with line/column", r.returncode != 0 and "not valid JSON" in r.stderr and "Traceback" not in r.stderr)

print("\nAll patcher tests passed." if failures == 0 else f"\n{failures} patcher test(s) FAILED.")
sys.exit(1 if failures else 0)
