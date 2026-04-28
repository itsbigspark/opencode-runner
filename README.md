# OpenCode Runner (FE + BE)

This folder provides:
- `frontend/`: React page with run form, live console, and artifacts table
- `backend/`: FastAPI service that triggers one OpenCode master command (`/ben-spec-process`)

## What This UI Runs

For each run, backend executes only:

```bash
opencode run --dir <ben_specs_repo> --model openai/gpt-5.4 --command ben-spec-process <excel_path> <output_dir>
```

So UI and terminal use the same pipeline behavior.
When `Allow local run` is ON in UI, backend runs Stage 1-3 directly (run context, extract, standardize, summary) and skips Stratio publish/workflow trigger.

## Prerequisites

1. OpenCode installed and available in PATH (`opencode --version`)
2. OpenCode authenticated (`~/.local/share/opencode/auth.json` exists), or `OPENAI_API_KEY` set in backend env
3. Stratio cookie and URLs set before backend start

## 1) Stratio Bootstrap (required before backend start)

```bash
cd /Users/bhagyashri_lohiya/Aviva/opencode-runner
source scripts/set_stratio_env.sh ~/.secrets/stratio.cookie
```

Quick cookie save helper (macOS):

```bash
# copy Stratio cookie value in browser first, then:
scripts/save_stratio_cookie.sh ~/.secrets/stratio.cookie
```

Practical cookie refresh flow:
1. Copy cookie in browser
2. Run `scripts/save_stratio_cookie.sh ~/.secrets/stratio.cookie`
3. Click `Refresh checks` in UI (or call `POST /api/stratio/refresh`)
4. Run pipeline

Supported env keys:
- `STRATIO_COOKIE` or `STRATIO_COOKIE_PATH`
- `ROCKET_BASE_URL` (BenSpecs contract) or `STRATIO_API_BASE_URL`
- `STRATIO_REQUIRE_API_PING` (`false` by default)
- `STRATIO_JDBC_URL`
- `STRATIO_JDBC_CHECK_COMMAND`
- `STRATIO_REQUIRE_JDBC` (`false` by default)

Note: backend auto-loads `STRATIO_COOKIE` from `STRATIO_COOKIE_PATH` for subprocesses, so
`ben-spec-process` can authenticate Rocket even when only cookie-path is set in `opencode-runner`.

## Backend setup

```bash
cd /Users/bhagyashri_lohiya/Aviva/opencode-runner/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health checks:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/preflight
curl http://localhost:8000/api/stratio/health
```

Stratio readiness endpoints:
- `GET /api/stratio/health`
- `POST /api/stratio/refresh`

## Frontend setup

```bash
cd /Users/bhagyashri_lohiya/Aviva/opencode-runner/frontend
npm install
npm run dev
```

Frontend will run on `http://localhost:5174`.

## 2) Local Run Sequence (exact order)

1. Source Stratio env (`source scripts/set_stratio_env.sh ...`)
2. Start backend (`uvicorn ...`)
3. Start frontend (`npm run dev`)
4. Open UI and click `Refresh checks`
5. Confirm preflight + Stratio badges are green
6. Run pipeline from UI

## Domnick Hunter E2E (local Stage 1-3)

Use these values in UI:
- `excel_path`: `/Users/bhagyashri_lohiya/Aviva/Schemes/Domnick Hunter/Domnick Hunter Data Masked (1).xlsx`
- `output_dir`: `/tmp/domnick_out_runner`
- `ben_specs_repo`: `/Users/bhagyashri_lohiya/Aviva/2604-AVIVA-BenSpecs`
- turn ON `Allow local run`

Notes:
- Local mode runs Stage 1-3 only.
- Output dir is cleaned before each run.
- Stratio-side input/output cleanup is still manual.

## API endpoints

- `POST /api/runs`
  - body:
    - `excel_path`: absolute path to workbook
    - `output_dir`: absolute output directory
    - `ben_specs_repo`: path to `2604-AVIVA-BenSpecs` (default prefilled)
- `GET /api/runs/{run_id}`
- `GET /api/runs/{run_id}/logs`
- `GET /api/runs/{run_id}/artifacts`
- `GET /api/runs/{run_id}/artifact?path=...`
- `GET /api/runs/{run_id}/artifacts.zip`

## UI Capabilities

- Stratio preflight/health badges (cookie required; API/JDBC optional unless enforced)
- Pipeline tracker (Intake/Extract/Standardize/Summarize)
- Stage Summary table (Find/Extract/Standardize rows)
- Live console stream
- Artifact list with per-file and zip download

## Troubleshooting

- `Stratio Not Connected`: refresh cookie, re-source env, restart backend
- If API ping is flaky in local dev, keep `STRATIO_REQUIRE_API_PING=false` (default)
- If JDBC is not ready yet, keep `STRATIO_REQUIRE_JDBC=false` (default)
- `opencode CLI/auth not ready`: run `opencode providers login` or set `OPENAI_API_KEY` in `backend/.env`
- Runs blocked at start: check `GET /api/preflight` and `GET /api/stratio/health` response details
