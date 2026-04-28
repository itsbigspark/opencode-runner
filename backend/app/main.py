from __future__ import annotations

import subprocess
import sys
import threading
import uuid
import tempfile
import zipfile
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
import shutil
import os
import re
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[1] / ".env")


PYTHON_EXE = sys.executable


class RunRequest(BaseModel):
    excel_path: str = Field(..., description="Absolute path to trustee workbook")
    output_dir: str = Field(..., description="Absolute output directory")
    ben_specs_repo: str = Field(
        "/Users/bhagyashri_lohiya/Aviva/2604-AVIVA-BenSpecs",
        description="Path to 2604-AVIVA-BenSpecs repo",
    )
    allow_local_run: bool = Field(
        False,
        description=(
            "When true, bypass Stratio health gate and run local pipeline only. "
            "OpenCode preflight is still required."
        ),
    )


class RunResponse(BaseModel):
    run_id: str
    status: str


@dataclass
class RunState:
    run_id: str
    status: Literal["queued", "running", "failed", "completed"] = "queued"
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    started_at: str | None = None
    finished_at: str | None = None
    output_dir: str = ""
    repo_dir: str = ""
    logs: list[str] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    error: str | None = None


RUNS: dict[str, RunState] = {}
RUNS_LOCK = threading.Lock()

app = FastAPI(title="OpenCode Runner API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _append_log(state: RunState, line: str) -> None:
    with RUNS_LOCK:
        state.logs.append(line.rstrip("\n"))


def _subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    cookie_value = (env.get("STRATIO_COOKIE") or "").strip()
    cookie_path = (env.get("STRATIO_COOKIE_PATH") or "").strip()
    if not cookie_value and cookie_path:
        p = Path(cookie_path).expanduser()
        if p.exists() and p.is_file():
            try:
                loaded = p.read_text(encoding="utf-8").strip()
                if loaded:
                    env["STRATIO_COOKIE"] = loaded
            except Exception:
                pass
    return env


def _run_command(state: RunState, cmd: list[str], cwd: Path) -> None:
    _append_log(state, f"$ {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=_subprocess_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        _append_log(state, line)
    exit_code = proc.wait()
    if exit_code != 0:
        raise RuntimeError(f"Command failed with exit code {exit_code}: {' '.join(cmd)}")


def _to_slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", (text or "").strip()).strip("_").lower() or "unknown_trustee"


def _list_artifacts(output_dir: Path) -> list[str]:
    if not output_dir.exists():
        return []
    return sorted(str(p) for p in output_dir.glob("*") if p.is_file())


def _has_non_empty_cookie_value() -> bool:
    cookie_value = (os.getenv("STRATIO_COOKIE") or "").strip()
    if cookie_value:
        return True
    cookie_path = (os.getenv("STRATIO_COOKIE_PATH") or "").strip()
    if not cookie_path:
        return False
    p = Path(cookie_path).expanduser()
    if not p.exists() or not p.is_file():
        return False
    try:
        content = p.read_text(encoding="utf-8").strip()
    except Exception:
        return False
    return bool(content)


def _preflight() -> dict:
    opencode_bin = shutil.which("opencode")
    opencode_cli = bool(opencode_bin)
    opencode_auth = Path.home() / ".local/share/opencode/auth.json"
    opencode_auth_present = opencode_auth.exists()

    stratio_api_url = _stratio_api_base_url()
    stratio_jdbc_url = (os.getenv("STRATIO_JDBC_URL") or "").strip()
    stratio_cookie_present = _has_non_empty_cookie_value()
    stratio_api_configured = bool(stratio_api_url)
    stratio_jdbc_configured = bool(stratio_jdbc_url)

    # For now we expose readiness from config presence only (no secret values,
    # no outbound call from this endpoint). This keeps it safe and deterministic.
    require_jdbc = (os.getenv("STRATIO_REQUIRE_JDBC") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    stratio_ready = (
        stratio_cookie_present
        and stratio_api_configured
        and (stratio_jdbc_configured if require_jdbc else True)
    )
    ready = opencode_cli and opencode_auth_present

    checks = {
        "backend": True,
        "opencode_cli": opencode_cli,
        "opencode_auth": opencode_auth_present,
        "stratio_cookie_present": stratio_cookie_present,
        "stratio_api_configured": stratio_api_configured,
        "stratio_jdbc_configured": stratio_jdbc_configured,
    }

    return {
        "ready": ready,
        "mode": "stratio_ready" if stratio_ready else "local_only",
        "checks": checks,
        "details": {
            "opencode_bin": opencode_bin or "",
            "stratio_api_base_url": stratio_api_url,
            "stratio_require_jdbc": require_jdbc,
            "notes": (
                "Local pipeline can run with OpenCode checks green. "
                "Stratio integration requires cookie + API base URL. "
                "JDBC is optional unless STRATIO_REQUIRE_JDBC=true."
            ),
        },
    }


def _stratio_cookie_value() -> str:
    cookie_value = (os.getenv("STRATIO_COOKIE") or "").strip()
    if cookie_value:
        return cookie_value
    cookie_path = (os.getenv("STRATIO_COOKIE_PATH") or "").strip()
    if not cookie_path:
        return ""
    p = Path(cookie_path).expanduser()
    if not p.exists() or not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _stratio_api_base_url() -> str:
    # Keep compatibility with BenSpecs env contract.
    # Prefer explicit STRATIO_API_BASE_URL, fallback to ROCKET_BASE_URL.
    return (
        (os.getenv("STRATIO_API_BASE_URL") or "").strip()
        or (os.getenv("ROCKET_BASE_URL") or "").strip()
    )


def _stratio_api_ping(api_base_url: str, cookie_value: str) -> tuple[bool, str]:
    if not api_base_url:
        return False, "STRATIO_API_BASE_URL/ROCKET_BASE_URL not set"
    # Use a lightweight endpoint commonly available on Stratio admin domains.
    # If this path is not exposed in a given environment, the error detail will guide setup.
    url = api_base_url.rstrip("/") + "/api/v1/projects"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Cookie", f"stratio-cookie={cookie_value}")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            status = getattr(resp, "status", 0)
            if 200 <= status < 300:
                return True, f"API ping OK ({status})"
            return False, f"API ping returned status {status}"
    except urllib.error.HTTPError as exc:
        return False, f"API ping failed with HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return False, f"API ping error: {exc}"


def _stratio_jdbc_check() -> tuple[bool, str]:
    # We avoid hardcoding a driver in backend; Ops can provide the exact check command.
    # Example:
    # export STRATIO_JDBC_CHECK_COMMAND='python /path/check_jdbc.py'
    cmd = (os.getenv("STRATIO_JDBC_CHECK_COMMAND") or "").strip()
    if not cmd:
        return False, "STRATIO_JDBC_CHECK_COMMAND not set"
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            check=False,
            text=True,
            capture_output=True,
            timeout=15,
        )
        if proc.returncode == 0:
            return True, "JDBC check OK"
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        msg = stderr or stdout or f"exit {proc.returncode}"
        return False, f"JDBC check failed: {msg}"
    except Exception as exc:  # noqa: BLE001
        return False, f"JDBC check error: {exc}"


def _stratio_health() -> dict:
    cookie_value = _stratio_cookie_value()
    cookie_ok = bool(cookie_value)
    api_base_url = _stratio_api_base_url()
    require_api_ping = (os.getenv("STRATIO_REQUIRE_API_PING") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    api_ok, api_msg = _stratio_api_ping(api_base_url, cookie_value) if cookie_ok else (False, "Cookie missing")
    require_jdbc = (os.getenv("STRATIO_REQUIRE_JDBC") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    jdbc_ok, jdbc_msg = _stratio_jdbc_check()
    connected = (
        cookie_ok
        and (api_ok if require_api_ping else bool(api_base_url))
        and (jdbc_ok if require_jdbc else True)
    )
    return {
        "connected": connected,
        "checks": {
            "cookie_present": cookie_ok,
            "api_ping_ok": api_ok,
            "api_ping_required": require_api_ping,
            "jdbc_ok": jdbc_ok,
            "jdbc_required": require_jdbc,
        },
        "details": {
            "api_base_url": api_base_url,
            "api_ping": api_msg,
            "api_ping_mode": "required" if require_api_ping else "optional",
            "jdbc": jdbc_msg,
            "jdbc_mode": "required" if require_jdbc else "optional",
            "cookie_source": "STRATIO_COOKIE or STRATIO_COOKIE_PATH",
        },
    }


def _execute_pipeline(state: RunState, req: RunRequest) -> None:
    repo_dir = Path(req.ben_specs_repo).resolve()
    excel_path = Path(req.excel_path).resolve()
    output_dir = Path(req.output_dir).resolve()

    if not repo_dir.exists():
        raise RuntimeError(f"Repo path does not exist: {repo_dir}")
    if not excel_path.exists():
        raise RuntimeError(f"Excel path does not exist: {excel_path}")

    # Clean requested output directory so each run has only fresh artifacts
    if output_dir.exists():
        for item in output_dir.iterdir():
            if item.is_file() or item.is_symlink():
                item.unlink()
            elif item.is_dir():
                shutil.rmtree(item)
    output_dir.mkdir(parents=True, exist_ok=True)

    state.repo_dir = str(repo_dir)
    state.output_dir = str(output_dir)

    # Run either:
    # - local-only Stage 1-3 (direct scripts), or
    # - full single command flow (ben-spec-process, includes publish/workflows).
    opencode_bin = shutil.which("opencode")
    if not opencode_bin:
        raise RuntimeError(
            "opencode CLI not found in PATH. Install OpenCode and ensure it is available to backend."
        )

    if req.allow_local_run:
        _append_log(state, "[INFO] Local-only mode: running Stage 1-3 (no Stratio publish)")
        _append_log(state, "[STAGE 0.5] Run context")
        _run_command(
            state,
            [
                PYTHON_EXE,
                ".opencode/commands/ben-spec-process/run_context.py",
                str(excel_path),
                str(output_dir),
            ],
            repo_dir,
        )

        _append_log(state, "[STAGE 1-2] Extract tables")
        _run_command(
            state,
            [
                PYTHON_EXE,
                ".opencode/commands/extract-pensioner-tables/extract_pensioner_tables.py",
                str(excel_path),
                str(output_dir),
            ],
            repo_dir,
        )

        trustee = _to_slug(excel_path.parent.name)
        table_specs = [
            ("current_pensioners", "current"),
            ("deferred_pensioners", "deferred"),
            ("net_payroll", "payroll"),
        ]
        for base_name, table_type in table_specs:
            extracted_csv = output_dir / f"{base_name}__{trustee}.csv"
            if extracted_csv.exists():
                _append_log(state, f"[STAGE 3] Standardize {table_type}")
                _run_command(
                    state,
                    [
                        PYTHON_EXE,
                        ".opencode/commands/standardize-pensioner-tables/standardize_pensioner_tables_csv.py",
                        str(extracted_csv),
                        str(output_dir),
                        "--table-type",
                        table_type,
                    ],
                    repo_dir,
                )
            else:
                _append_log(
                    state,
                    f"[WARN] Skipping standardize {table_type}: extracted file not found ({extracted_csv.name})",
                )

        _append_log(state, "[STAGE 3] Build process summary")
        _run_command(
            state,
            [
                PYTHON_EXE,
                ".opencode/commands/ben-spec-process/build_standardization_process_summary.py",
                str(output_dir),
                str(excel_path),
            ],
            repo_dir,
        )
        _append_log(state, "[DONE] Local-only Stage 1-3 completed")
    else:
        _run_command(
            state,
            [
                opencode_bin,
                "run",
                "--dir",
                str(repo_dir),
                "--model",
                "openai/gpt-5.4",
                "--dangerously-skip-permissions",
                "--command",
                "ben-spec-process",
                str(excel_path),
                str(output_dir),
            ],
            repo_dir,
        )

    state.artifacts = _list_artifacts(output_dir)


def _run_worker(run_id: str, req: RunRequest) -> None:
    with RUNS_LOCK:
        state = RUNS[run_id]
        state.status = "running"
        state.started_at = datetime.now(timezone.utc).isoformat()
    try:
        _execute_pipeline(state, req)
        with RUNS_LOCK:
            state.status = "completed"
            state.finished_at = datetime.now(timezone.utc).isoformat()
    except Exception as exc:  # noqa: BLE001
        with RUNS_LOCK:
            state.status = "failed"
            state.error = str(exc)
            state.finished_at = datetime.now(timezone.utc).isoformat()
            state.artifacts = _list_artifacts(Path(req.output_dir))
            state.logs.append(f"[ERROR] {exc}")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/preflight")
def get_preflight() -> dict:
    return _preflight()


@app.get("/api/stratio/health")
def get_stratio_health() -> dict:
    return _stratio_health()


@app.post("/api/stratio/refresh")
def refresh_stratio_health() -> dict:
    # Stateless refresh: re-read env/cookie file and re-run checks.
    return _stratio_health()


@app.post("/api/runs", response_model=RunResponse)
def create_run(req: RunRequest) -> RunResponse:
    pre = _preflight()
    if not pre["ready"]:
        raise HTTPException(
            status_code=400,
            detail="Preflight failed: OpenCode CLI/auth not ready on backend host.",
        )
    stratio = _stratio_health()
    if not req.allow_local_run and not stratio["connected"]:
        raise HTTPException(
            status_code=400,
            detail=(
                "Stratio health failed. Refresh cookie/env and restart session, "
                "or enable local-only mode in UI. "
                f"Details: API={stratio['details']['api_ping']}; JDBC={stratio['details']['jdbc']}"
            ),
        )
    run_id = str(uuid.uuid4())
    state = RunState(run_id=run_id)
    with RUNS_LOCK:
        RUNS[run_id] = state
    thread = threading.Thread(target=_run_worker, args=(run_id, req), daemon=True)
    thread.start()
    return RunResponse(run_id=run_id, status=state.status)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    with RUNS_LOCK:
        state = RUNS.get(run_id)
        if not state:
            raise HTTPException(status_code=404, detail="Run not found")
        return {
            "run_id": state.run_id,
            "status": state.status,
            "created_at": state.created_at,
            "started_at": state.started_at,
            "finished_at": state.finished_at,
            "repo_dir": state.repo_dir,
            "output_dir": state.output_dir,
            "error": state.error,
        }


@app.get("/api/runs/{run_id}/logs")
def get_run_logs(run_id: str) -> dict:
    with RUNS_LOCK:
        state = RUNS.get(run_id)
        if not state:
            raise HTTPException(status_code=404, detail="Run not found")
        return {"run_id": state.run_id, "logs": state.logs}


@app.get("/api/runs/{run_id}/artifacts")
def get_run_artifacts(run_id: str) -> dict:
    with RUNS_LOCK:
        state = RUNS.get(run_id)
        if not state:
            raise HTTPException(status_code=404, detail="Run not found")
        return {"run_id": state.run_id, "artifacts": state.artifacts}


@app.get("/api/runs/{run_id}/artifact")
def download_artifact(run_id: str, path: str) -> FileResponse:
    with RUNS_LOCK:
        state = RUNS.get(run_id)
        if not state:
            raise HTTPException(status_code=404, detail="Run not found")
        allowed = set(state.artifacts)
    resolved = str(Path(path).resolve())
    if resolved not in allowed:
        raise HTTPException(status_code=403, detail="Artifact not available for this run")
    file_path = Path(resolved)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found on disk")
    return FileResponse(path=str(file_path), filename=file_path.name, media_type="application/octet-stream")


@app.get("/api/runs/{run_id}/artifacts.zip")
def download_all_artifacts(run_id: str) -> FileResponse:
    with RUNS_LOCK:
        state = RUNS.get(run_id)
        if not state:
            raise HTTPException(status_code=404, detail="Run not found")
        artifacts = list(state.artifacts)
    if not artifacts:
        raise HTTPException(status_code=404, detail="No artifacts available for this run")

    fd, zip_path_str = tempfile.mkstemp(prefix=f"{run_id}_", suffix="_artifacts.zip")
    Path(zip_path_str).unlink(missing_ok=True)
    zip_path = Path(zip_path_str)
    try:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path_str in artifacts:
                p = Path(path_str).resolve()
                if p.exists() and p.is_file():
                    zf.write(p, arcname=p.name)
    except Exception as exc:  # noqa: BLE001
        zip_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Failed to build zip: {exc}") from exc

    return FileResponse(
        path=str(zip_path),
        filename=f"artifacts_{run_id}.zip",
        media_type="application/zip",
        background=BackgroundTask(lambda p: Path(p).unlink(missing_ok=True), str(zip_path)),
    )
