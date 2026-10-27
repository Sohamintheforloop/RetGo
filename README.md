# Retro Game Auto-Patcher

Helps older PC games run on modern Windows. Open source, built for one person and a few friends.

You tell it which game and which folder. It finds the game's program, then walks you through a short **setup window**:

1. **Find the game** in the folder you gave.
2. **Windows compatibility settings**: the same switches as right-click, Properties, Compatibility (fullscreen optimizations, Windows XP mode, run as administrator...). Per game, per Windows account, with an **Undo** that restores exactly what was there before.
3. **Fix pack** (where one exists): reviewed files copied into the game folder, with a permission step that lists every file, backups of anything replaced, and a **Remove** that puts everything back.
4. **Launch and test**, with notes for that game.

Optional extras: AI troubleshooting advice, a community request list, and end-to-end encrypted requests to the maintainers. The core of the app needs no internet service at all.

## What it can and cannot do (read this)

| Game | What the app offers |
|---|---|
| Max Payne, Max Payne 2 | Compatibility options plus a **modern-Windows fix pack**: widescreen/ultrawide and Direct3D, audio and controller wrappers, made by a third party (ThirteenAG's WidescreenFixesPack) |
| S.T.A.L.K.E.R. (original 2007 game, `xr_3DA.exe`) | Compatibility options only |
| Anything else ("Other game") | Compatibility options only. You choose the game's `.exe` |

* **No byte patches for real games.** Patching bytes needs offsets verified against an exact game build, and none are verified yet. The only byte-patch demo is the fictional `demo_game`, used to test the app.
* **S.T.A.L.K.E.R. Legends of the Zone Trilogy Enhanced Edition** is an official modern release. Start it from your store first; it usually needs no changes. Its `.exe` names are not in the catalogue, so add it as "Other game" if you want compatibility options.
* **Nothing here was tested against the real games**, because the author could not run them. Everything was tested with simulated game folders (see Tests). Try each fix on a **copy** of the game folder first, and remember that Remove and Undo exist.
* The fix packs are **program files** (`.dll`, `.asi`) that run inside the game. Antivirus tools sometimes flag them. They come from the author's official release page and are pinned by SHA-256.

## Quick start: build the app once (you)

Requirements: Windows 10/11, **Node.js 22.12 or newer**, **Python 3.11 or newer** (tick "Add python.exe to PATH"), internet for the first build.

1. Unzip the project somewhere short, for example `C:\dev\retro-game-auto-patcher`.
2. Open **Command Prompt** (not PowerShell) in that folder and run:
   ```bat
   build_exe.bat
   ```
   It downloads the fix packs from their official pages and verifies their fingerprints, builds the web app, and packages everything into **one file**: `backend\dist\RetroGamePatcher.exe` (about 80 MB). It prints the file's SHA-256.
3. Test it yourself (next section). Then send that one `.exe` to your friends. They need nothing else.

If `build_exe.bat` says **upstream changed**, the author updated a fix pack in place. The build stops on purpose so nothing changes silently. Look at the new release, then accept it with `python tools\fetch_fixes.py --repin` and build again.

## Using the app (you and your friends)

1. **Double-click `RetroGamePatcher.exe`.** A black window opens (leave it open) and your browser opens the app at `http://127.0.0.1:8000`. Close the black window to stop the app.
2. Read the short first-run notice, tick the box, press **Continue**.
3. Open **Settings**, scroll to **Add a game**.
4. Choose **Which game**. Paste the game's **folder**. Tip: open it in File Explorer, click the address bar, copy. For Steam: right-click the game, Manage, **Browse local files**.
5. Press **Find and add game**. The app finds the program itself. (For "Other game" with several programs, you pick the right one.) **The setup window opens by itself.**
6. In the setup window, go down the steps:
   * Step 2: tick the options you want (the recommended one is already ticked), tick the confirmation box, press **Apply these settings**.
   * Step 3: press **Install**, read the file list, tick the box, press **Allow and install**.
7. Start the game the way you normally do. Follow the notes in the last step.
8. Something wrong? Open the game's **Set up game** button again and use **Remove** (fix pack) or **Undo** (compatibility). Both put the game back as it was.

Games in **Program Files** (the default Steam location): Windows may refuse to let the app write there. If you see "Permission denied", right-click the `.exe` and choose **Run as administrator**, or move your Steam library to another folder.

Later you can open **Settings** to name your own **tabs** (for example "Steam", "GOG"), turn the **backup switch** on or off, or paste your own **Groq key** for the optional AI advice.

## Development

```bat
run_dev.bat
```
Checks Node and Python, installs what is missing, fetches the fix packs, starts the edge worker, the patcher and the web app in one window, and opens http://localhost:5173. Press Ctrl+C to stop. (The edge worker is only needed for the optional online help.)

Layout:

```
frontend/  React 19 + TypeScript + Vite + Tailwind v4   (the web app and the setup window)
backend/   FastAPI patcher: scan, compatibility, fix packs, byte patches; the ONLY part that touches files or the registry
worker/    Cloudflare Worker: optional AI advice, community and encrypted requests
catalog/   games.json and file_fixes.json: the one list of games and fix packs (all three parts read it)
payloads/  fix-pack files: downloaded by tools/fetch_fixes.py, git-ignored, bundled into the .exe
tools/     dev.py, fetch_fixes.py, payload_manifest.py, maintainer.py
```

## Tests

```bat
cd frontend && npm test                       :: 39 UI tests (Settings, setup window, fix panel, error screen)
cd worker   && npm test                       :: 26 route tests
cd backend  && python tests\test_patcher.py   :: 87 checks (stub registry, temp folders, the REAL Max Payne fix pack)
python tools\payload_manifest.py --check      :: every bundled file is listed, fingerprinted and an allowed type
```
These use a stand-in registry and temporary folders: they never touch your real registry or games. GitHub Actions runs all of them on every push.

## Adding a game or a fix pack (maintainers)

* **A game that only needs compatibility options:** add an entry to `catalog/games.json` (`exe_names`, `compat.recommended`, `compat.optional`, `launch_notes`). Allowed options: `WINXPSP3`, `WIN98`, `WIN7RTM` (only one), `RUNASADMIN`, `DISABLEDXMAXIMIZEDWINDOWEDMODE`, `HIGHDPIAWARE`, `640X480`, `16BITCOLOR`.
* **A fix pack from a GitHub release:** add an entry to `catalog/file_fixes.json` with a `download` block (`url`, leave `sha256`/`size` empty) and one `files` entry per file you want (`member` = path inside the zip, `payload` = where it is stored, `dest` = where it goes in the game folder). Then run `python tools\fetch_fixes.py --repin`, which downloads it and writes the fingerprints. Allowed file types: `.dll .ini .asi .cfg .txt`. Only one fix should write a given destination file.
* **Never** commit third-party binaries. `payloads/` for downloaded packs is git-ignored.

## Optional online help (edge worker)

Only for AI advice, the community list and private encrypted requests. Deploy with `cd worker`, `npx wrangler login`, `npx wrangler kv namespace create REQUESTS` (paste the id into `wrangler.toml`), `npx wrangler secret put GROQ_API_KEY`, `npx wrangler secret put MAINTAINER_TOKEN`, `npm run deploy`, then set `VITE_WORKER_URL` in `frontend/.env.local` before building. Private requests use ECDH P-256, HKDF-SHA256 and AES-256-GCM; `python tools\maintainer.py keygen` makes the maintainer key (keep the `.pem` offline). Public write routes have **rate limiting written but commented out**: enable it before sharing the Worker address widely.

## Security notes

* The patcher listens on `127.0.0.1` only, checks the `Host` header, and by default accepts requests only from its own pages (`PATCHER_ALLOWED_ORIGINS` can change that). Every change needs the permission tick from the UI.
* Compatibility settings: fixed list of options, per Windows account, previous value saved and restored exactly; changes you made yourself later are never overwritten.
* Fix packs: the app never downloads anything while running; files are re-hashed before every install; destinations must stay inside the game folder; writes are atomic with rollback; removal only deletes files that are still unchanged.
* The first-run notice, privacy and terms are short plain-language notes, not legal agreements. Change them if you ever share the app more widely, and check the upstream licences of the fix packs first.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Could not reach the local patcher" | The black window was closed. Start `RetroGamePatcher.exe` again |
| `wrangler: not found`, `vite: not found`, a dark "This site can't be reached" page (development) | `npm install` was never run. Use `run_dev.bat`, which installs for you |
| `Node.js ... is too old` | Install Node 22.12 or newer from nodejs.org and open a new Command Prompt |
| "Could not find MaxPayne.exe in that folder" | Pick the folder that contains the game, or paste the full path of the `.exe` |
| "Permission denied" | Close the game; if it is in Program Files, run the app as administrator |
| "Bundled fix file is missing" (development) | Run `python tools\fetch_fixes.py` |
| Build says "upstream changed" | Review the author's new release, then `python tools\fetch_fixes.py --repin` |
| A blank page in the packaged app | Press F12 and read the Console: the strict Content-Security-Policy names what it blocked |
| Antivirus flags a fix pack | Expected for `.dll` hooks. Remove the fix pack, or only use it if you trust the source |
