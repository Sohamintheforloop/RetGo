#!/usr/bin/env python3
"""
One-command development launcher (Windows, macOS, Linux). Standard library only.

    python tools/dev.py               check tools, install anything missing, start everything, open the browser
    python tools/dev.py --setup-only  install and configure, then stop
    python tools/dev.py --no-browser  do not open the browser

It runs three programs in ONE window with labelled logs, so nothing is hidden in extra black windows:
    [worker]   edge API        http://localhost:8787
    [patcher]  local patcher   http://127.0.0.1:8000
    [ui]       the web app     http://localhost:5173
Press Ctrl+C once to stop all three.
"""
import collections
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
WORKER, BACKEND, FRONTEND = (os.path.join(ROOT, d) for d in ("worker", "backend", "frontend"))
IS_WIN = os.name == "nt"
MIN_NODE = (22, 12)  # wrangler needs 22+, vitest needs 22.12+, vite needs 20.19+ or 22.12+
MIN_PY = (3, 11)
PORTS = [(8787, "edge worker"), (8000, "local patcher"), (5173, "web app")]
CHECKS = [("worker", "http://localhost:8787/health"), ("patcher", "http://127.0.0.1:8000/health"), ("ui", "http://localhost:5173/")]

if hasattr(sys.stdout, "reconfigure"):  # tools such as wrangler print emoji; never crash on a Windows code page
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def say(msg):
    print(f"[setup] {msg}", flush=True)


def die(msg):
    print(f"\nERROR: {msg}\n", flush=True)
    sys.exit(1)


def check_tools():
    if sys.version_info < MIN_PY:
        die(f"Python {MIN_PY[0]}.{MIN_PY[1]} or newer is required (you have {sys.version.split()[0]}).\n"
            "  Install it from https://www.python.org/downloads/ and tick 'Add python.exe to PATH'.")
    node, npm = shutil.which("node"), shutil.which("npm")
    if not node or not npm:
        die("Node.js was not found.\n  Install the LTS version (22.12 or newer) from https://nodejs.org,\n"
            "  then close this window and open a new Command Prompt so it picks up the new PATH.")
    out = subprocess.run([node, "-v"], capture_output=True, text=True).stdout.strip()
    try:
        major, minor = (int(x) for x in out.lstrip("v").split(".")[:2])
    except ValueError:
        die(f"Could not read the Node.js version (got {out!r}).")
    if (major, minor) < MIN_NODE:
        die(f"Node.js {out} is too old. This project's tools need {MIN_NODE[0]}.{MIN_NODE[1]} or newer\n"
            "  (wrangler needs 22+). Install the current LTS from https://nodejs.org and reopen the window.")
    say(f"Node {out}, Python {sys.version.split()[0]}: OK")
    return npm


def ensure_env_files():
    for folder, example, real in ((WORKER, ".dev.vars.example", ".dev.vars"), (FRONTEND, ".env.example", ".env.local")):
        dst = os.path.join(folder, real)
        if not os.path.isfile(dst):
            shutil.copyfile(os.path.join(folder, example), dst)
            say(f"Created {os.path.basename(folder)}/{real} from its example.")
    with open(os.path.join(WORKER, ".dev.vars"), encoding="utf-8-sig") as fh:
        if "gsk_your_key_here" in fh.read():
            say("NOTE: worker/.dev.vars has no Groq key yet. AI patch plans and advice will fail until you add one there,")
            say("      or paste your own key in the app under Settings > Groq AI engine. Everything else works without it.")


def ensure_npm(folder, npm):
    name = os.path.basename(folder)
    if os.path.isdir(os.path.join(folder, "node_modules", ".bin")):
        return
    say(f"Installing packages for '{name}' (first run only, can take a few minutes)...")
    verb = "ci" if os.path.isfile(os.path.join(folder, "package-lock.json")) else "install"
    if subprocess.call([npm, verb, "--no-audit", "--no-fund"], cwd=folder) != 0:
        die(f"'npm {verb}' failed in {name}. Read the messages above (no internet? an old Node version?), then run this again.")


def venv_python():
    return os.path.join(BACKEND, ".venv", "Scripts" if IS_WIN else "bin", "python.exe" if IS_WIN else "python")


def ensure_backend():
    py = venv_python()
    if not os.path.isfile(py):
        say("Creating the Python environment for 'backend'...")
        if subprocess.call([sys.executable, "-m", "venv", ".venv"], cwd=BACKEND) != 0:
            die("Could not create the Python virtual environment in backend/.venv.")
    probe = subprocess.call([py, "-c", "import fastapi, uvicorn, pydantic"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe != 0:
        say("Installing Python packages for 'backend' (first run only)...")
        if subprocess.call([py, "-m", "pip", "install", "-r", "requirements-dev.txt", "--disable-pip-version-check"], cwd=BACKEND) != 0:
            die("pip install failed. Read the messages above, then run this again.")
    return py


def ensure_payloads():
    """The Max Payne fix packs are not stored in the repository: fetch them from the authors' official release pages."""
    say("Checking the fix packs (downloaded from the authors' official release pages if missing)...")
    rc = subprocess.call([sys.executable, os.path.join(ROOT, "tools", "fetch_fixes.py")])
    if rc != 0:
        say("WARNING: the fix packs could not be fetched (offline?). Everything else works; fix packs will show an error until you run:")
        say("         python tools/fetch_fixes.py")


def port_in_use(port):
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                if s.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            pass
    return False


PROCS = []  # (name, Popen, tail)


def start(name, cmd, cwd):
    kwargs = dict(cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
    if IS_WIN:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(cmd, **kwargs)
    tail = collections.deque(maxlen=12)

    def pump():
        for line in proc.stdout:
            line = line.rstrip()
            tail.append(line)
            print(f"[{name}] {line}", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    PROCS.append((name, proc, tail))


def stop_all():
    for _, proc, _ in PROCS:
        if proc.poll() is None:
            try:
                if IS_WIN:
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
                else:
                    os.killpg(proc.pid, signal.SIGTERM)
            except Exception:
                pass
    deadline = time.time() + 6
    for _, proc, _ in PROCS:
        while proc.poll() is None and time.time() < deadline:
            time.sleep(0.2)
        if not IS_WIN:  # the leader may be gone while its children (workerd, vite, ...) linger: kill the whole group
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass


def explain_exit(name, proc, tail):
    print(f"\nERROR: the {name} stopped on its own (exit code {proc.returncode}). Its last messages:", flush=True)
    for line in tail:
        print(f"    {line}", flush=True)
    print(flush=True)


def wait_ready(timeout=240):
    pending, begun = dict(CHECKS), time.time()
    while pending and time.time() - begun < timeout:
        for name, proc, tail in PROCS:
            if proc.poll() is not None:
                time.sleep(0.5)  # let the last output arrive
                explain_exit(name, proc, tail)
                return False
        for name, url in list(pending.items()):
            try:
                urllib.request.urlopen(url, timeout=2).close()
                ok = True
            except urllib.error.HTTPError:
                ok = True  # the server answered, just not with 200
            except Exception:
                ok = False
            if ok:
                say(f"{name} is ready: {url}")
                del pending[name]
        time.sleep(1)
    if pending:
        print(f"\nERROR: timed out waiting for: {', '.join(pending)}. Read the labelled messages above.\n", flush=True)
        return False
    return True


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def main():
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):  # SIGBREAK = Ctrl+Break / closing the console on Windows
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), _interrupt)
    args = sys.argv[1:]
    npm = check_tools()
    ensure_env_files()
    ensure_npm(WORKER, npm)
    ensure_npm(FRONTEND, npm)
    py = ensure_backend()
    ensure_payloads()
    if "--setup-only" in args:
        say("Setup complete.")
        return
    busy = [f"{port} ({what})" for port, what in PORTS if port_in_use(port)]
    if busy:
        die("These ports are already in use: " + ", ".join(busy) + ".\n"
            "  Most likely a previous run is still open. Close that window (or Ctrl+C in it) and try again.")
    start("worker", [npm, "run", "dev"], WORKER)
    start("patcher", [py, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000", "--reload"], BACKEND)
    start("ui", [npm, "run", "dev", "--", "--port", "5173", "--strictPort"], FRONTEND)
    try:
        if wait_ready():
            print("\n" + "=" * 62 + "\n  READY. Open  http://localhost:5173\n  Press Ctrl+C in this window to stop everything.\n" + "=" * 62 + "\n", flush=True)
            if "--no-browser" not in args:
                webbrowser.open("http://localhost:5173")
            while all(p.poll() is None for _, p, _ in PROCS):
                time.sleep(1)
            for name, proc, tail in PROCS:
                if proc.poll() is not None:
                    explain_exit(name, proc, tail)
                    break
    except KeyboardInterrupt:
        print("\nStopping...", flush=True)
    finally:
        stop_all()


if __name__ == "__main__":
    main()
