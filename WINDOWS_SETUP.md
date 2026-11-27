# Freelance AI Agent Hub — Windows 10/11 & Cloud Deployment Guide

Run **Freelance AI Agent Hub** directly on your own Windows 10/11 PC or any standalone cloud server (VPS, Railway, Render, Fly.io, Cloud Run) without any sandbox dependency.

---

## 1. Windows 10/11 Requirements

- **Node.js 22.13 LTS or newer** (required by Vite 8 and built-in `node:sqlite` — no Visual Studio C++ build tools required; verified automatically by `install.ps1`)
- **Ollama for Windows** (recommended for local-first AI models): https://ollama.com/download/windows
  - After installing Ollama, pull a local model:
    ```powershell
    ollama pull llama3.1:8b
    ```
- **8 GB+ RAM** (resource-aware scheduler defaults to 1 concurrent agent for modest PCs)

---

## 2. Quick Start on Windows (PowerShell or Command Prompt)

You can run the scripts from any directory (all scripts automatically resolve the repository root and read your configured `PORT` and `HOST` from `.env`).

Use the `.cmd` launchers below so Windows does not block downloaded `.ps1` scripts with a PowerShell digital-signature error:

```powershell
# 1. Verify Node >= 22.13 + node:sqlite, generate persistent secrets, build UI, init SQLite
.\scripts\install.cmd

# 2. Launch unified server on your configured PORT (default http://127.0.0.1:3000)
.\scripts\start.cmd

# 3. Verify health of server, SQLite database, and local Ollama
.\scripts\check-health.cmd

# 4. Create a SQLite WAL-consistent, integrity-verified backup (+ optional separate encrypted key backup)
.\scripts\backup.cmd -PromptForKeyBackup

# 5. Stop the server cleanly
.\scripts\stop.cmd
```

If you prefer calling the `.ps1` scripts directly without changing your system-wide PowerShell policy, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

---

## 3. Cloud / Linux Deployment

The same server runs natively on any Node.js 22.13+ host. By default, the server binds strictly to `127.0.0.1` so it is never accidentally exposed on a LAN or public network. For cloud deployments, explicitly set `HOST=0.0.0.0` alongside a pre-configured `HUB_ADMIN_PASSCODE` and persistent `HUB_SECRET_ENCRYPTION_KEY`:

```bash
npm ci
npm run build
PORT=3000 HOST=0.0.0.0 NODE_ENV=production npm start
```

Cross-platform maintenance commands (work on both Windows and Linux/macOS):
- `npm run backup` — creates a WAL-consistent, integrity-verified ZIP archive with `backup_manifest.json` and `RESTORE_INSTRUCTIONS.md`.
- `npm run backup:key -- --passphrase "<12+ char passphrase>"` — exports a separately encrypted key backup (`.keybackup.enc.json`) to store outside your database backup.
- `npm run clean` — removes `dist/` and `server.js` using cross-platform Node `fs.rmSync`.

Set `HUB_ADMIN_PASSCODE` and `HUB_SECRET_ENCRYPTION_KEY` in your cloud host environment variables (never commit `.env` to git). Remote first-run admin setup is blocked even when `HOST=0.0.0.0`.

---

## 4. First-Run Security Setup

On your first visit to `http://127.0.0.1:<PORT>`:
1. `.\scripts\install.ps1` automatically generates a persistent `HUB_SECRET_ENCRYPTION_KEY` and a `HUB_SETUP_TOKEN` in `.env` (restricted to your Windows user via `icacls`).
2. First-run admin setup (`/api/auth/bootstrap`) is restricted to localhost (`127.0.0.1` / `::1`) and validates `HUB_SETUP_TOKEN` whenever configured. Both login and bootstrap enforce rate limiting, progressive delays, and temporary lockout on repeated failures.
3. All operational `/api/*` endpoints (including detailed `/api/system/diagnostics`) require a valid session token. The unauthenticated `/api/health` endpoint returns only minimal `{ "status": "ok" }`.
4. Optional external API keys are encrypted at rest with AES-256-GCM using your persistent encryption key (stored in `.env` or `FreelanceAgentHub/.hub-secret.key` outside SQLite) and are verified on startup.

---

## 5. Workspace Layout & Disaster Recovery

All project artifacts are strictly confined to:

```text
FreelanceAgentHub/
  data/hub.db              # SQLite database (WAL mode, foreign keys)
  backups/                 # Verified WAL-consistent ZIP backups + manifests
  logs/                    # Server stdout/stderr logs
  projects/
    <project_id>/
      requirements/
      research/
      source_data/
      working_files/
      deliverables/        # Real DOCX, XLSX, CSV, PDF, PPTX, HTML, ZIP files
      tests/
      reports/
      logs/
      project_plan.md
      qa_report.md
      submission_message.md
```

**Disaster Recovery**: Follow `RESTORE_INSTRUCTIONS.md` inside any backup archive. Restore `data/hub.db` and `projects/`, decrypt your separately stored key backup via `npx tsx src/server/db/backup.ts --restore-key <file> --passphrase "<passphrase>"`, and place `HUB_SECRET_ENCRYPTION_KEY` into `.env` before starting the server.

---

## 6. Troubleshooting

- **Port already in use**: Set `PORT=3001` in `.env` — `start.ps1`, `check-health.ps1`, and `stop.ps1` automatically read `PORT` from `.env`.
- **Ollama shows Offline**: Ensure Ollama is running (`ollama serve`) and reachable at `http://127.0.0.1:11434`, then click **Test Connection** in **Settings → AI Providers**. Without an active AI provider, project execution produces labeled fallback drafts routed to the mandatory Human Review Gate.
- **Platform connector says Manual Only**: Platforms like Upwork, Fiverr, Freelancer.com, PeoplePerHour, Guru, and Wellfound prohibit automated scraping. Use the built-in **Manual Import (URL / Description / CSV / JSON)** workflow in **Job Discovery**.
