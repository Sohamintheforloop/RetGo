# Third-party audit

Re-run this review whenever dependencies change. Commands: `npm audit`, `npx license-checker --summary` (frontend and worker),
`pip install pip-audit pip-licenses && pip-audit && pip-licenses` (backend).

| Component | Role | Runs where | Personal data it can see | Licence (verify on update) | Decision |
|---|---|---|---|---|---|
| React, Vite, Tailwind CSS v4 | UI build and runtime | Your device | None | MIT | Keep |
| Fontsource Inter / JetBrains Mono | Self-hosted fonts | Your device | None (no Google Fonts request) | Packages MIT; fonts SIL OFL 1.1 | Keep. Ship the OFL text with the .exe |
| FastAPI, Starlette, Uvicorn, Pydantic | Local patcher API | Your device (127.0.0.1) | File paths (stay local) | MIT / BSD | Keep |
| PyInstaller | Builds the .exe | Build machine | None | GPL-2.0 with bootloader exception, output may be distributed under your licence | Keep; read their licence note |
| Cloudflare Workers + Wrangler | Edge API hosting | Cloudflare | IP address and request metadata (as network provider) | Service ToS / DPA; Wrangler open source | Keep. Disclosed in Privacy clause 4 |
| Groq API | LLM inference | Groq | Only public game text, no user data | Service ToS | Keep. Set a spend cap; confirm data-retention settings |
| Web Crypto API (browser built-in) | End-to-end encryption in the app | Your device | Plaintext of private requests (never leaves the device unencrypted) | Part of the browser | Keep. No crypto library added |
| `cryptography` (Python) | Maintainer tool only (`tools/`) | Maintainer machine | Decrypted private requests | Apache-2.0 / BSD | Keep. Not shipped in the .exe |
| Cloudflare KV | Stores help requests (90-day TTL) | Cloudflare | Scrubbed public text; ciphertext only for private | Service ToS / DPA | Keep. Disclosed in Privacy clause 4b |
| ThirteenAG WidescreenFixesPack (Max Payne and Max Payne 2 packs) | Optional fix packs: widescreen plus Direct3D, audio and controller wrappers (include DxWrapper, DSOAL, Xidi and an ASI loader) | The player's PC, inside the game folder | None | Third-party open-source components: see https://github.com/ThirteenAG/WidescreenFixesPack | Fetched from the author's official release at build time and pinned by SHA-256. Never stored in this repository. Check the upstream licences before sharing the .exe beyond friends |
| PCGamingWiki text | Source of fix notes | n/a (mock text now) | None | CC BY-NC-SA | **Do not use real text in a paid/PaaS product** without permission |

Rejected on purpose: analytics, crash-reporting SDKs, ad networks, Google Fonts CDN, social login, any CDN-hosted scripts.
