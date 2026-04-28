import { useEffect, useMemo, useState } from "react";

const API_BASE = "http://localhost:8000";
const STRATIO_LINKS = [
  {
    label: "GenAI Questions",
    url: "https://admin.aviva.stratio.com/genai-ui.pre-genai/questions"
  },
  {
    label: "Discovery Virtualizer",
    url: "https://admin.aviva.stratio.com/discovery.pre-discovery/browse/databases/1-virtualizer"
  }
];

const initialForm = {
  excel_path: "",
  output_dir: "",
  ben_specs_repo: "/Users/bhagyashri_lohiya/Aviva/2604-AVIVA-BenSpecs",
  allow_local_run: false
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        value += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (ch !== "\r") {
      value += ch;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function isSuccessStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "✓" || s === "ok" || s === "finished" || s === "success";
}

function isFailureStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "✗" || s === "ko" || s === "failed" || s === "error";
}

function parseStageTableFromLogs(logLines) {
  if (!Array.isArray(logLines) || logLines.length === 0) return [];
  const lines = logLines.map((line) => stripAnsi(line).trim());
  const headerRegex = /^\|\s*Stage\s*\|\s*Table\s*\|\s*Status\s*\|\s*Detail\s*\|$/i;
  const separatorRegex = /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/;

  let headerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (headerRegex.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return [];

  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    if (separatorRegex.test(line)) continue;

    const parts = line.split("|").slice(1, -1).map((p) => p.trim());
    if (parts.length < 4) continue;
    rows.push({
      stage: parts[0],
      table: parts[1],
      status: parts[2],
      detail: parts.slice(3).join(" | ")
    });
  }
  return rows;
}

function App() {
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [runId, setRunId] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [runMeta, setRunMeta] = useState({
    created_at: "",
    started_at: "",
    finished_at: "",
    output_dir: ""
  });
  const [activeView, setActiveView] = useState("dashboard");
  const [summaryRows, setSummaryRows] = useState([]);
  const [preflight, setPreflight] = useState(null);
  const [stratioHealth, setStratioHealth] = useState(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  const isActiveRun = useMemo(
    () => status === "queued" || status === "running",
    [status]
  );
  const runBlockReason = useMemo(() => {
    if (!preflight?.ready) return "Preflight not ready (OpenCode CLI/auth check failed)";
    const stratioConnected = Boolean(
      stratioHealth?.connected || preflight?.mode === "stratio_ready"
    );
    if (!form.allow_local_run && !stratioConnected) {
      return "Stratio not connected (cookie/API/JDBC checks failed)";
    }
    return "";
  }, [form.allow_local_run, preflight, stratioHealth]);
  const canRun = !loading && !isActiveRun && !runBlockReason;

  const artifactStats = useMemo(() => {
    const extracted = artifacts.filter(
      (a) =>
        a.endsWith(".csv") &&
        !a.includes("_standardized") &&
        !a.includes("standardization_process_summary_")
    ).length;
    const standardized = artifacts.filter((a) =>
      a.includes("_standardized.csv")
    ).length;
    const reports = artifacts.filter(
      (a) =>
        a.includes("standardization_process_summary_")
    ).length;
    return { extracted, standardized, reports };
  }, [artifacts]);

  const summaryArtifact = useMemo(
    () =>
      artifacts.find((a) =>
        a.includes("standardization_process_summary_")
      ) || "",
    [artifacts]
  );

  const stageSummaryRows = useMemo(() => {
    if (summaryRows.length === 0) return [];
    if (summaryRows.some((r) => r.section)) {
      return summaryRows.filter((r) => r.section === "stage");
    }
    return summaryRows;
  }, [summaryRows]);
  const logStageTableRows = useMemo(
    () => parseStageTableFromLogs(logs),
    [logs]
  );
  const stageTableRows = useMemo(() => {
    if (logStageTableRows.length > 0) return logStageTableRows;
    return stageSummaryRows.map((row) => ({
      stage: row.Stage || row.stage || "-",
      table: row.Table || row.table || "-",
      status: row.Status || row.status || "-",
      detail: row.Detail || row.detail || "-"
    }));
  }, [logStageTableRows, stageSummaryRows]);
  const summaryByTable = useMemo(() => {
    const grouped = {};
    for (const row of stageTableRows) {
      const tableName = row.table || "unknown_table";
      if (!grouped[tableName]) grouped[tableName] = [];
      grouped[tableName].push({
        stage: row.stage || "-",
        status: row.status || "-",
        detail: row.detail || "-"
      });
    }
    return grouped;
  }, [stageTableRows]);

  const runDuration = useMemo(() => {
    if (!runMeta.started_at) return "-";
    const start = new Date(runMeta.started_at).getTime();
    const end = runMeta.finished_at
      ? new Date(runMeta.finished_at).getTime()
      : Date.now();
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [runMeta]);

  const pipelineSteps = useMemo(() => {
    const rows = stageTableRows;
    const byStage = (stageName) =>
      rows.filter(
        (r) => String(r.stage || "").trim().toLowerCase() === stageName.toLowerCase()
      );
    const findRows = byStage("find");
    const extractRows = byStage("extract");
    const standardizeRows = byStage("standardize");
    const publishRows = byStage("publish");
    const publishInfraRows = publishRows.filter(
      (r) => !/^dq\d+/i.test(String(r.table || "").trim())
    );
    const validateRows = publishRows.filter((r) =>
      /^dq\d+/i.test(String(r.table || "").trim())
    );

    const summarizeState = (stageRows, fallbackDone = false) => {
      if (stageRows.length === 0) {
        return fallbackDone ? "done" : "idle";
      }
      if (stageRows.some((r) => isFailureStatus(r.status))) return "failed";
      if (stageRows.every((r) => isSuccessStatus(r.status))) return "done";
      return isActiveRun ? "active" : "idle";
    };

    const hasExtracted = artifacts.some(
      (a) =>
        a.endsWith(".csv") &&
        !a.includes("_standardized") &&
        !a.includes("standardization_process_summary_")
    );
    const hasStandardized = artifacts.some((a) => a.includes("_standardized.csv"));
    const hasProcessSummary = artifacts.some((a) =>
      a.includes("standardization_process_summary_")
    );

    const steps = [
      {
        title: "Intake",
        desc: "Workbook accepted",
        state: runId ? "done" : "idle"
      },
      {
        title: "Find",
        desc: "Canonical sheets matched",
        state: summarizeState(findRows)
      },
      {
        title: "Extract",
        desc: "Source tables created",
        state: summarizeState(extractRows, hasExtracted)
      },
      {
        title: "Standardise",
        desc: "Canonical outputs + checks",
        state: summarizeState(standardizeRows, hasStandardized)
      },
      {
        title: "Summarise",
        desc: "Stage-wise report ready",
        state: hasProcessSummary ? "done" : "idle"
      },
      {
        title: "Publish",
        desc: "FileBrowser upload + ontology",
        state: summarizeState(publishInfraRows)
      },
      {
        title: "Validate",
        desc: "DQ02 / DQ08 / DQ10 workflows",
        state: summarizeState(validateRows)
      }
    ];

    if (isActiveRun) {
      const firstPending = steps.find(
        (s) => s.state === "idle" || s.state === "active"
      );
      if (firstPending && firstPending.state === "idle") {
        firstPending.state = "active";
      }
    }

    return steps.map((s) => ({
      ...s,
      done: s.state === "done",
      active: s.state === "active",
      failed: s.state === "failed"
    }));
  }, [artifacts, isActiveRun, runId, stageTableRows]);

  const startRun = async (e) => {
    e.preventDefault();
    if (!preflight?.ready) {
      setError("Preflight not ready. Check OpenCode CLI/auth on backend host.");
      return;
    }
    const stratioConnected = Boolean(
      stratioHealth?.connected || preflight?.mode === "stratio_ready"
    );
    if (!form.allow_local_run && !stratioConnected) {
      setError("Stratio not connected. Refresh cookie/env and rerun health checks.");
      return;
    }
    setLoading(true);
    setError("");
    setLogs([]);
    setArtifacts([]);
    try {
      const res = await fetch(`${API_BASE}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      if (!res.ok) throw new Error(`Failed to start run (${res.status})`);
      const data = await res.json();
      setRunId(data.run_id);
      setStatus(data.status);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const refreshPreflight = async () => {
    setPreflightLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/preflight`);
      if (!res.ok) throw new Error(`Preflight failed (${res.status})`);
      const data = await res.json();
      setPreflight(data);
    } catch (err) {
      setPreflight(null);
      setError(err.message || String(err));
    } finally {
      setPreflightLoading(false);
    }
  };

  const refreshStratioHealth = async () => {
    setPreflightLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/stratio/health`);
      if (!res.ok) throw new Error(`Stratio health failed (${res.status})`);
      const data = await res.json();
      setStratioHealth(data);
    } catch (err) {
      setStratioHealth(null);
      setError(err.message || String(err));
    } finally {
      setPreflightLoading(false);
    }
  };

  useEffect(() => {
    refreshPreflight();
    refreshStratioHealth();
  }, []);

  useEffect(() => {
    if (!runId) return;
    const id = setInterval(async () => {
      const [runRes, logsRes, artifactsRes] = await Promise.all([
        fetch(`${API_BASE}/api/runs/${runId}`),
        fetch(`${API_BASE}/api/runs/${runId}/logs`),
        fetch(`${API_BASE}/api/runs/${runId}/artifacts`)
      ]);
      if (!runRes.ok) return;
      const runData = await runRes.json();
      setStatus(runData.status);
      setError(runData.error || "");
      setRunMeta({
        created_at: runData.created_at || "",
        started_at: runData.started_at || "",
        finished_at: runData.finished_at || "",
        output_dir: runData.output_dir || ""
      });
      if (logsRes.ok) {
        const logData = await logsRes.json();
        setLogs(logData.logs || []);
      }
      if (artifactsRes.ok) {
        const artifactData = await artifactsRes.json();
        setArtifacts(artifactData.artifacts || []);
      }
    }, 1200);
    return () => clearInterval(id);
  }, [runId]);

  useEffect(() => {
    if (!runId || !summaryArtifact) {
      setSummaryRows([]);
      return;
    }
    const url = `${API_BASE}/api/runs/${runId}/artifact?path=${encodeURIComponent(summaryArtifact)}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error("Could not load summary artifact");
        return res.text();
      })
      .then((csvText) => setSummaryRows(parseCsv(csvText)))
      .catch(() => setSummaryRows([]));
  }, [runId, summaryArtifact]);

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-kicker">BPA ONBOARDING</div>
        <h1>BPA Data Intake and Standardisation</h1>
        <p>Run extraction, standardisation, and reporting from one interface</p>
      </header>

      <section className="card view-tabs">
        <button
          type="button"
          className={activeView === "dashboard" ? "tab active-tab" : "tab"}
          onClick={() => setActiveView("dashboard")}
        >
          Dashboard
        </button>
        <button
          type="button"
          className={activeView === "summary" ? "tab active-tab" : "tab"}
          onClick={() => setActiveView("summary")}
        >
          Stage Summary
        </button>
        <button
          type="button"
          className={activeView === "artifacts" ? "tab active-tab" : "tab"}
          onClick={() => setActiveView("artifacts")}
        >
          Artifacts
        </button>
        <button
          type="button"
          className={activeView === "logs" ? "tab active-tab" : "tab"}
          onClick={() => setActiveView("logs")}
        >
          Live Logs
        </button>
      </section>

      {activeView === "dashboard" ? (
        <>
          <section className="dashboard-grid">
        <div className="card control-panel">
          <h2>Run Control</h2>
          <form onSubmit={startRun} className="form">
            <label>
              Excel path
              <input
                required
                value={form.excel_path}
                onChange={(e) =>
                  setForm((s) => ({ ...s, excel_path: e.target.value }))
                }
                placeholder="/Users/.../file.xlsx"
              />
            </label>
            <label>
              Output directory
              <input
                required
                value={form.output_dir}
                onChange={(e) =>
                  setForm((s) => ({ ...s, output_dir: e.target.value }))
                }
                placeholder="/tmp/bicknell_out"
              />
            </label>
            <label>
              BenSpecs repo
              <input
                required
                value={form.ben_specs_repo}
                onChange={(e) =>
                  setForm((s) => ({ ...s, ben_specs_repo: e.target.value }))
                }
              />
            </label>
            <div className="toggle-row">
              <span>Allow local run (bypass Stratio health gate)</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.allow_local_run}
                className={`toggle-switch ${form.allow_local_run ? "toggle-on" : ""}`}
                onClick={() =>
                  setForm((s) => ({ ...s, allow_local_run: !s.allow_local_run }))
                }
                title={form.allow_local_run ? "Local-only mode ON" : "Local-only mode OFF"}
              >
                <span className="toggle-knob" />
              </button>
            </div>
            <button type="submit" disabled={!canRun} title={runBlockReason || ""}>
              {loading ? "Starting..." : "Run pipeline"}
            </button>
            {runBlockReason ? (
              <p className="error">Run blocked: {runBlockReason}. Click "Refresh checks" after fixing env/cookie.</p>
            ) : null}
            {form.allow_local_run ? (
              <p className="error">
                Local-only mode enabled: run can start without Stratio connection.
              </p>
            ) : null}
            {!runBlockReason && error ? <p className="error">{error}</p> : null}
          </form>
          <div className="meta">
            <div>
              <strong>Run ID</strong>
              <span>{runId || "-"}</span>
            </div>
            <div>
              <strong>Output</strong>
              <span>{runMeta.output_dir || "-"}</span>
            </div>
          </div>
          <div className="quick-downloads">
            <strong>Preflight</strong>
            <div className="preflight-head">
              <span className={`preflight-pill ${preflight?.ready ? "preflight-ok" : "preflight-bad"}`}>
                {preflight?.ready ? "Ready" : "Not ready"}
              </span>
              <span className={`preflight-pill ${preflight?.mode === "stratio_ready" ? "preflight-ok" : "preflight-warn"}`}>
                {preflight?.mode === "stratio_ready" ? "Stratio Ready" : "Local Only"}
              </span>
              <span className={`preflight-pill ${stratioHealth?.connected ? "preflight-ok" : "preflight-bad"}`}>
                {stratioHealth?.connected ? "Stratio Connected" : "Stratio Not Connected"}
              </span>
              <button
                type="button"
                className="tab"
                onClick={async () => {
                  await refreshPreflight();
                  await refreshStratioHealth();
                }}
                disabled={preflightLoading}
              >
                {preflightLoading ? "Checking..." : "Refresh checks"}
              </button>
            </div>
            <div className="preflight-grid">
              <span>OpenCode CLI</span>
              <span>{preflight?.checks?.opencode_cli ? "✓" : "✗"}</span>
              <span>OpenCode Auth</span>
              <span>{preflight?.checks?.opencode_auth ? "✓" : "✗"}</span>
              <span>Stratio Cookie</span>
              <span>{preflight?.checks?.stratio_cookie_present ? "✓" : "✗"}</span>
              <span>Stratio API</span>
              <span>{preflight?.checks?.stratio_api_configured ? "✓" : "✗"}</span>
              <span>Stratio JDBC</span>
              <span>{preflight?.checks?.stratio_jdbc_configured ? "✓" : "✗"}</span>
              <span>Stratio API Ping</span>
              <span>{stratioHealth?.checks?.api_ping_ok ? "✓" : "✗"}</span>
              <span>Stratio JDBC Query</span>
              <span>{stratioHealth?.checks?.jdbc_ok ? "✓" : "✗"}</span>
            </div>
          </div>
          <div className="quick-downloads">
            <strong>Stratio Links</strong>
            <div className="quick-download-list">
              {STRATIO_LINKS.map((link) => (
                <a
                  key={link.url}
                  className="download-link"
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  title={link.url}
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="kpi-grid">
          <article className="kpi-card">
            <h3>Status</h3>
            <div className={`status-pill status-${status}`}>{status}</div>
          </article>
          <article className="kpi-card">
            <h3>Run Duration</h3>
            <div className="kpi-value">{runDuration}</div>
          </article>
          <article className="kpi-card">
            <h3>Artifacts</h3>
            <div className="kpi-value">{artifacts.length}</div>
          </article>
          <article className="kpi-card">
            <h3>Log Lines</h3>
            <div className="kpi-value">{logs.length}</div>
          </article>
          <article className="kpi-card">
            <h3>Extracted</h3>
            <div className="kpi-value">{artifactStats.extracted}</div>
          </article>
          <article className="kpi-card">
            <h3>Standardised</h3>
            <div className="kpi-value">{artifactStats.standardized}</div>
          </article>
          <article className="kpi-card">
            <h3>Reports</h3>
            <div className="kpi-value">{artifactStats.reports}</div>
          </article>
          <article className="kpi-card">
            <h3>Health</h3>
            <div className="kpi-value">
              {status === "completed"
                ? "Good"
                : status === "failed"
                  ? "Review"
                  : "Running"}
            </div>
          </article>
        </div>
          </section>

          <section className="card pipeline-card">
        <h2>Pipeline Tracker</h2>
        <div className="pipeline">
          {pipelineSteps.map((step) => (
            <div
              key={step.title}
              className={`step ${step.done ? "step-done" : ""} ${step.active ? "step-active" : ""} ${step.failed ? "step-failed" : ""}`}
            >
              <div className="step-dot" />
              <div className="step-title">
                <span>{step.title}</span>
                <span className="step-state-icon">
                  {step.failed ? "✗" : step.done ? "✓" : step.active ? "…" : "•"}
                </span>
              </div>
              <div className="step-desc">{step.desc}</div>
            </div>
          ))}
        </div>
          </section>
        </>
      ) : null}

      {activeView === "summary" ? (
        <section className="card summary-card">
          <h2>Stage Summary</h2>
          {!summaryArtifact ? (
            <p>No summary artifact yet</p>
          ) : stageTableRows.length === 0 ? (
            <p>Loading summary…</p>
          ) : (
            <div className="summary-grid">
              {Object.entries(summaryByTable).map(([tableName, rows]) => (
                <article className="summary-block" key={tableName}>
                  <div className="summary-block-head">
                    <h3>{tableName}</h3>
                    <span className="summary-count">{rows.length} steps</span>
                  </div>
                  <div className="summary-rows">
                    {rows.map((r, idx) => {
                      const rawStatus = String(r.status || "-").trim().toLowerCase();
                      const statusClass =
                        rawStatus === "✓" || rawStatus === "finished"
                          ? "summary-status-ok"
                          : rawStatus === "warn" || rawStatus === "warning"
                            ? "summary-status-warn"
                            : "summary-status-bad";
                      return (
                        <div className="summary-row" key={`${tableName}-${r.stage}-${idx}`}>
                          <div className="summary-row-meta">
                            <span className="summary-stage">{r.stage}</span>
                            <span className={`summary-status ${statusClass}`}>
                              {r.status}
                            </span>
                          </div>
                          <div className="summary-detail path">{r.detail}</div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeView === "artifacts" ? (
        <section className="card">
          <h2>Artifacts</h2>
          {runId && artifacts.length > 0 ? (
            <div className="artifacts-head-actions">
              <a
                className="download-link"
                href={`${API_BASE}/api/runs/${runId}/artifacts.zip`}
                target="_blank"
                rel="noreferrer"
              >
                Download all (.zip)
              </a>
            </div>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Path</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.length === 0 ? (
                <tr>
                  <td colSpan={3}>No artifacts yet</td>
                </tr>
              ) : (
                artifacts.map((a, idx) => (
                  <tr key={a}>
                    <td>{idx + 1}</td>
                    <td className="path">{a}</td>
                    <td>
                      {runId ? (
                        <a
                          className="download-link"
                          href={`${API_BASE}/api/runs/${runId}/artifact?path=${encodeURIComponent(a)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Download
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      ) : null}

      {activeView === "logs" ? (
        <section className="card">
          <h2>Live Console</h2>
          {error ? <p className="error">{error}</p> : null}
          <pre className="console">{logs.join("\n") || "No logs yet"}</pre>
        </section>
      ) : null}
    </div>
  );
}

export default App;
