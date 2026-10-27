# Security policy

Report vulnerabilities privately to the contact address in `frontend/src/legal.ts` (CONTACT_EMAIL), or through GitHub's
"Report a vulnerability" button on this repository. Please do not open a public issue for security problems.

Scope notes: the local patcher edits files and the registry on the user's machine, so reports about its allow-lists
(`catalog/games.json`, `backend/main.py`), the end-to-end encryption (`frontend/src/crypto.ts`, `tools/maintainer.py`),
or the Worker's validation (`worker/src/index.ts`) are the highest priority.
