"use client";

import { ChangeEvent, DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseCsv, stringifyCsv } from "@/lib/csv";
import { isValidEmailAddress } from "@/lib/email";
import { deleteProject, readProject, requestPersistentStorage, writeProject } from "@/lib/storage";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { EnrichmentProject, EnrichmentRow, RowStatus } from "@/lib/types";

type StatusFilter = "all" | RowStatus;

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];
const ACCOUNT_EMAIL = "mashcatg@gmail.com";

export default function Home() {
  const [project, setProject] = useState<EnrichmentProject | null>(null);
  const projectRef = useRef<EnrichmentProject | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [jobStatus, setJobStatus] = useState<{
    id: string;
    status: "queued" | "running" | "waiting_for_keys" | "paused" | "completed";
    total_count: number;
    completed_count: number;
    found_count: number;
    not_found_count: number;
    failed_count: number;
  } | null>(null);
  const [keyAlerts, setKeyAlerts] = useState<Array<{ id: string; key_index: number; message: string }>>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSubmittingJob, setIsSubmittingJob] = useState(false);
  const [notice, setNotice] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const appliedResultsForJobRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    try {
      const supabase = createSupabaseBrowserClient();
      void (async () => {
        try {
          const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
          if (!active) return;
          if (sessionError) throw sessionError;
          if (!sessionData.session) {
            setIsAuthenticated(false);
            setAuthError("");
            setAuthReady(true);
            return;
          }
          const { data, error } = await supabase.auth.getUser();
          if (error) throw error;
          setIsAuthenticated(data.user?.email?.toLowerCase() === ACCOUNT_EMAIL);
          setAuthError("");
          setAuthReady(true);
        } catch (error) {
          if (!active) return;
          setAuthError(error instanceof Error ? error.message : "Could not verify your login.");
          setIsAuthenticated(false);
          setAuthReady(true);
        }
      })();
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        setIsAuthenticated(session?.user.email?.toLowerCase() === ACCOUNT_EMAIL);
        if (!session) setAuthError("");
      });
      return () => {
        active = false;
        subscription.unsubscribe();
      };
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Supabase authentication is not configured.");
      setAuthReady(true);
    }
  }, []);

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSigningIn(true);
    setAuthError("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: ACCOUNT_EMAIL,
        password: loginPassword,
      });
      if (error) throw error;
      if (data.user?.email?.toLowerCase() !== ACCOUNT_EMAIL) {
        await supabase.auth.signOut();
        throw new Error(`Only ${ACCOUNT_EMAIL} is authorized.`);
      }
      setIsAuthenticated(true);
      setLoginPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setIsSigningIn(false);
    }
  };

  const signOut = async () => {
    const { error } = await createSupabaseBrowserClient().auth.signOut();
    if (error) setErrorMessage(error.message);
    else setIsAuthenticated(false);
  };

  const save = useCallback(async (next: EnrichmentProject) => {
    try {
      await writeProject(next);
      projectRef.current = next;
      setProject(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the project locally.";
      setErrorMessage(message);
      throw error;
    }
  }, []);

  useEffect(() => {
    let active = true;
    readProject()
      .then(async (saved) => {
        if (!active) return;
        if (saved) {
          let hasChanges = false;
          let removedInvalidEmails = 0;
          const recovered = {
            ...saved,
            rows: saved.rows.map((row) => {
              const cells = [...row.cells];
              const email = cells[saved.emailColumnIndex]?.trim() ?? "";
              if (!isValidEmailAddress(email)) {
                let rowChanged = false;
                if (email) {
                  cells[saved.emailColumnIndex] = "";
                  rowChanged = true;
                  removedInvalidEmails += 1;
                }
                const hasWebsite = Boolean(cells[saved.websiteColumnIndex]?.trim());
                const status = hasWebsite ? "pending" as const : "missing_website" as const;
                if (row.status === "complete" || row.status === "running" || (email && row.status !== status)) {
                  rowChanged = true;
                }
                if (rowChanged) {
                  hasChanges = true;
                  return { ...row, cells, status, error: undefined };
                }
              } else if (row.status === "running") {
                hasChanges = true;
                return { ...row, status: "complete" as const, error: undefined };
              }
              if (row.status === "running") {
                hasChanges = true;
                return { ...row, status: "pending" as const };
              }
              return row;
            }),
          };
          projectRef.current = recovered;
          setProject(recovered);
          if (hasChanges) {
            await writeProject(recovered);
          }
          if (removedInvalidEmails > 0) {
            setNotice(
              `Removed ${removedInvalidEmails} invalid email value${removedInvalidEmails === 1 ? "" : "s"} from old results. Those rows are ready to retry.`,
            );
          }
        }
      })
      .catch((error: unknown) => {
        if (active) setErrorMessage(error instanceof Error ? error.message : "Could not restore the saved project.");
      })
      .finally(() => {
        if (active) setIsHydrated(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const jobId = project?.jobId;
    if (!isAuthenticated || !jobId) {
      setJobStatus(null);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not read job progress.");
        if (!active) return;
        if (result.status === "completed" && appliedResultsForJobRef.current !== jobId) {
          setJobStatus({ ...result, status: "running" });
          const resultsResponse = await fetch(`/api/jobs/${jobId}/results`, { cache: "no-store" });
          const resultBody = await resultsResponse.json();
          if (!resultsResponse.ok) throw new Error(resultBody.error ?? "Could not retrieve completed results.");
          const resultByRow = new Map<number, { email: string; status: RowStatus; error?: string }>(
            resultBody.results.map((entry: { rowIndex: number; email: string; status: RowStatus; error?: string }) => [
              entry.rowIndex,
              { email: entry.email, status: entry.status, error: entry.error },
            ]),
          );
          const latest = projectRef.current;
          if (active && latest && latest.jobId === jobId) {
            const rows = latest.rows.map((row, rowIndex) => {
              const found = resultByRow.get(rowIndex);
              if (!found) return row;
              const cells = [...row.cells];
              cells[latest.emailColumnIndex] = found.email;
              return { ...row, cells, status: found.status, error: found.error };
            });
            await save({ ...latest, rows, updatedAt: Date.now() });
            appliedResultsForJobRef.current = jobId;
            setNotice("Enrichment finished. Results are saved locally and ready to export.");
          }
        }
        if (active) setJobStatus(result);
      } catch (error) {
        if (active) setErrorMessage(error instanceof Error ? error.message : "Could not refresh job progress.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isAuthenticated, project?.jobId, save]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let active = true;
    const refreshAlerts = async () => {
      try {
        const response = await fetch("/api/analytics", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not check key notifications.");
        if (active) {
          setKeyAlerts((data.notifications ?? []).filter((item: { resolved_at: string | null }) => !item.resolved_at));
        }
      } catch (error) {
        if (active) setErrorMessage(error instanceof Error ? error.message : "Could not load notifications.");
      }
    };
    void refreshAlerts();
    const timer = window.setInterval(() => { void refreshAlerts(); }, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "development" ||
      !isAuthenticated ||
      !project?.jobId ||
      !jobStatus ||
      !["queued", "running"].includes(jobStatus.status)
    ) return;
    let active = true;
    let retryTimer: number | undefined;
    let retryDelay = 15_000;

    const runLocalWorker = async () => {
      try {
        const response = await fetch("/api/worker", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Local worker could not run.");
        if (result.workerError) throw new Error(result.workerError);
        retryDelay = result.processed === 0 ? 15_000 : 2_000;
      } catch (error) {
        retryDelay = 15_000;
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : "Local worker could not run.");
        }
      } finally {
        if (active) retryTimer = window.setTimeout(() => { void runLocalWorker(); }, retryDelay);
      }
    };

    void runLocalWorker();
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [isAuthenticated, jobStatus?.status, project?.jobId]);

  const resolveKeyAlert = async (id: string) => {
    try {
      const response = await fetch(`/api/notifications/${id}/resolve`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not resolve this key alert.");
      setKeyAlerts((alerts) => alerts.filter((alert) => alert.id !== id));
      setNotice("Firecrawl key re-enabled. The worker will retry queued websites.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not resolve this key alert.");
    }
  };

  const setCampaignPaused = async (action: "pause" | "resume") => {
    if (!jobStatus || isSubmittingJob) return;
    setIsSubmittingJob(true);
    setErrorMessage("");
    try {
      const response = await fetch(`/api/jobs/${jobStatus.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Could not ${action} this campaign.`);
      setJobStatus((current) => current ? { ...current, ...result } : current);
      setNotice(action === "pause"
        ? "Campaign paused. Any request already in progress may finish."
        : "Campaign resumed.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not ${action} this campaign.`);
    } finally {
      setIsSubmittingJob(false);
    }
  };

  const counts = useMemo(() => {
    const rows = project?.rows ?? [];
    return {
      total: rows.length,
      complete: rows.filter((row) => row.status === "complete").length,
      pending: rows.filter((row) => row.status === "pending" || row.status === "failed" || row.status === "not_found").length,
      notFound: rows.filter((row) => row.status === "not_found").length,
      failed: rows.filter((row) => row.status === "failed").length,
    };
  }, [project]);

  const visibleRows = useMemo(() => {
    if (!project) return [];
    const query = search.trim().toLowerCase();
    return project.rows.filter((row) => {
      const matchesStatus = statusFilter === "all" || row.status === statusFilter;
      const matchesSearch = !query || row.cells.some((cell) => cell.toLowerCase().includes(query));
      return matchesStatus && matchesSearch;
    });
  }, [project, search, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const safePage = Math.min(currentPage, pageCount);
  const pageRows = visibleRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    setCurrentPage(1);
  }, [pageSize, search, statusFilter]);

  useEffect(() => {
    if (currentPage > pageCount) setCurrentPage(pageCount);
  }, [currentPage, pageCount]);

  const importFile = useCallback(async (file?: File) => {
    if (!file || !isHydrated) return;
    setErrorMessage("");
    setNotice("");
    let persistenceError: string | null = null;
    let removedInvalidEmails = 0;
    const persistencePromise = requestPersistentStorage().catch((error: unknown) => {
      persistenceError = error instanceof Error ? error.message : "The browser could not enable persistent storage.";
      return false;
    });
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.length < 2) throw new Error("This CSV needs a header row and at least one data row.");
      const headers = parsed[0].map((header) => header.trim());
      const websiteColumnIndex = headers.findIndex((header) => header.toLowerCase() === "website");
      if (websiteColumnIndex < 0) throw new Error('No "website" column was found. Check the header and try again.');
      let emailColumnIndex = headers.findIndex((header) => header.toLowerCase() === "email");
      if (emailColumnIndex < 0) {
        emailColumnIndex = headers.length;
        headers.push("email");
      }
      const rows: EnrichmentRow[] = parsed.slice(1).map((cells, index) => {
        const padded = [...cells];
        while (padded.length < parsed[0].length) padded.push("");
        while (padded.length < headers.length) padded.push("");
        const hasWebsite = Boolean(padded[websiteColumnIndex]?.trim());
        const hasEmail = isValidEmailAddress(padded[emailColumnIndex]?.trim() ?? "");
        if (!hasEmail && padded[emailColumnIndex]?.trim()) {
          padded[emailColumnIndex] = "";
          removedInvalidEmails += 1;
        }
        return {
          id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          cells: padded,
          status: !hasWebsite ? "missing_website" : hasEmail ? "complete" : "pending",
        };
      });
      const next: EnrichmentProject = {
        headers,
        rows,
        websiteColumnIndex,
        emailColumnIndex,
        fileName: file.name,
        updatedAt: Date.now(),
      };
      await save(next);
      const persistent = await persistencePromise;
      setSearch("");
      setStatusFilter("all");
      setCurrentPage(1);
      if (persistenceError) {
        setErrorMessage(`The CSV was saved locally, but persistent storage could not be enabled: ${persistenceError}`);
        setNotice("");
      } else {
        const importMessage = persistent
          ? `Imported ${rows.length.toLocaleString()} rows from ${file.name}. Your browser will retain this workspace across reloads.`
          : `Imported ${rows.length.toLocaleString()} rows from ${file.name} and saved it locally. Clearing browser data may remove it.`;
        setNotice(removedInvalidEmails > 0
          ? `${importMessage} Cleared ${removedInvalidEmails} invalid email value${removedInvalidEmails === 1 ? "" : "s"}.`
          : importMessage);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not read this CSV file.");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [isHydrated, save]);

  const isEnriching = isSubmittingJob || jobStatus?.status === "queued" ||
    jobStatus?.status === "running" || jobStatus?.status === "waiting_for_keys";
  const hasIncompleteJob = Boolean(jobStatus && jobStatus.status !== "completed");
  const enrichRows = async () => {
    const current = projectRef.current;
    if (!current || isEnriching) return;
    const entries = current.rows.flatMap((row, rowIndex) => {
      if (!["pending", "failed", "not_found"].includes(row.status)) return [];
      const website = row.cells[current.websiteColumnIndex]?.trim();
      return website ? [{ rowIndex, website }] : [];
    });
    if (entries.length === 0) {
      setNotice("There are no rows ready to enrich.");
      return;
    }
    setIsSubmittingJob(true);
    setErrorMessage("");
    setNotice("");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: current.fileName, entries }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not start enrichment.");
      appliedResultsForJobRef.current = null;
      await save({ ...current, jobId: result.id, updatedAt: Date.now() });
      setNotice(`Queued ${entries.length.toLocaleString()} websites across ${result.chunkCount} worker chunks.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not start enrichment.");
    } finally {
      setIsSubmittingJob(false);
    }
  };

  const exportCsv = () => {
    if (!project) return;
    const content = stringifyCsv([project.headers, ...visibleRows.map((row) => row.cells)]);
    const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    const filterSuffix = statusFilter !== "all" || search.trim() ? "-filtered" : "";
    link.download = project.fileName.replace(/\.csv$/i, "") + `${filterSuffix}-enriched.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(
      filterSuffix
        ? `Exported ${visibleRows.length.toLocaleString()} rows matching the current search and filter.`
        : `Exported all ${visibleRows.length.toLocaleString()} rows. Your local project is still saved.`,
    );
  };

  const clearProject = async () => {
    const current = projectRef.current;
    if (!current || isSubmittingJob) return;
    if (!window.confirm(
      `Remove ${current.fileName} and all its server jobs and saved results? This also removes the local CSV copy and cannot be undone.`,
    )) return;
    setIsSubmittingJob(true);
    setErrorMessage("");
    try {
      if (isAuthenticated) {
        const response = await fetch("/api/jobs", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: current.fileName }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not delete server jobs.");
      }
      await deleteProject();
      projectRef.current = null;
      setProject(null);
      setJobStatus(null);
      setNotice("The saved CSV, its server jobs, and their results were removed.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not remove the saved CSV and its server jobs.");
    } finally {
      setIsSubmittingJob(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void importFile(event.dataTransfer.files[0]);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void importFile(event.target.files?.[0]);
  };

  const successPercent = counts.total ? Math.round((counts.complete / counts.total) * 100) : 0;
  const remainingCount = hasIncompleteJob && jobStatus
    ? Math.max(0, jobStatus.total_count - jobStatus.completed_count)
    : counts.pending;
  const estimatedMinutes = Math.ceil((remainingCount * 6) / 60);
  const jobPercent = jobStatus?.total_count
    ? Math.round((jobStatus.completed_count / jobStatus.total_count) * 100)
    : 0;

  if (!authReady) {
    return <main className="auth-shell"><p>Checking your secure sign-in…</p></main>;
  }

  if (!isAuthenticated) {
    return (
      <main className="auth-shell">
        <form className="auth-card" onSubmit={(event) => void signIn(event)}>
          <a className="brand" href="#" aria-label="Enrich home">
            <span className="brand-mark">e</span><span>enrich<span className="brand-dot">.</span></span>
          </a>
          <h1>Welcome back</h1>
          <p>Sign in to your email enrichment workspace.</p>
          <label className="field-label" htmlFor="account-email">ACCOUNT</label>
          <input id="account-email" className="auth-input" value={ACCOUNT_EMAIL} readOnly />
          <label className="field-label" htmlFor="account-password">PASSWORD</label>
          <input
            id="account-password"
            className="auth-input"
            type="password"
            autoComplete="current-password"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            required
          />
          {authError && <p className="auth-error" role="alert">{authError}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={isSigningIn}>
            {isSigningIn ? "Signing in…" : "Sign in"}
          </button>
          <small>Password is configured for this account in Supabase Auth.</small>
        </form>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Enrich home">
          <span className="brand-mark">e</span>
          <span>enrich<span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-right">
          <a className="help-link" href="/analytics">Analytics</a>
          <span className="local-pill"><span className="local-dot" /> Background worker</span>
          <a className="help-link" href="https://docs.firecrawl.dev/" target="_blank" rel="noreferrer">Firecrawl docs <span aria-hidden="true">↗</span></a>
          <button className="text-button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>

      <div className="workspace">
        <section className="intro">
          <div className="eyebrow"><span className="eyebrow-line" /> EMAIL ENRICHMENT</div>
          <h1>Find the right<br /><span>way to reach them.</span></h1>
          <p>Upload a CSV. Server-side Firecrawl workers process it while you’re away, and results merge into your local CSV.</p>
        </section>

        <section className="setup-card" aria-label="Enrichment setup">
          <div className="section-heading">
            <div className="step-number">01</div>
            <div>
              <h2>Firecrawl worker pool</h2>
              <p>API keys are configured on the server and never exposed to the browser.</p>
            </div>
          </div>
          <div className="worker-summary">
            <span className="status-indicator" />
            <span>10 protected key slots · globally rate-limited · durable job queue</span>
            <a href="/analytics">View worker health →</a>
          </div>
        </section>

        {keyAlerts.map((alert) => (
          <section className="key-alert" key={alert.id} role="alert">
            <div><strong>Firecrawl key {alert.key_index} paused</strong><span>{alert.message}</span></div>
            <button className="button button-quiet" onClick={() => void resolveKeyAlert(alert.id)}>Resolved · re-enable key</button>
          </section>
        ))}

        {!project ? (
          <section className="upload-section" aria-label="Upload CSV">
            <div className="section-heading upload-heading">
              <div className="step-number">02</div>
              <div>
                <h2>Upload your list</h2>
                <p>We’ll look for a column named <code>website</code>.</p>
              </div>
            </div>
            <div
              className={`dropzone${isDragging ? " is-dragging" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click(); }}
            >
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={onFileChange} hidden />
              <span className="upload-icon" aria-hidden="true"><span>↑</span></span>
              <strong>Drop your CSV here, or <span>browse files</span></strong>
              <small>CSV files only · Full CSV stays in this browser; only row numbers and websites are sent to the job queue.</small>
            </div>
          </section>
        ) : (
          <section className="results-section">
            <div className="section-heading results-heading">
              <div className="step-number">02</div>
              <div>
                <h2>Your enrichment list</h2>
                <p><span className="file-icon">▤</span> {project.fileName} <span className="muted-separator">·</span> {counts.total.toLocaleString()} rows</p>
              </div>
              <div className="results-actions">
                <button className="button button-quiet" onClick={() => void clearProject()} disabled={isSubmittingJob}>Start over</button>
                <button className="button button-export" onClick={exportCsv} disabled={visibleRows.length === 0}>
                  <span aria-hidden="true">↓</span> Export {statusFilter !== "all" || search.trim() ? `${visibleRows.length.toLocaleString()} filtered` : "CSV"}
                </button>
              </div>
            </div>

            <div className="stats-grid">
              <div className="stat-card"><span className="stat-label">TOTAL ROWS</span><strong>{counts.total.toLocaleString()}</strong><span className="stat-caption">in your list</span></div>
              <div className="stat-card"><span className="stat-label">EMAILS FOUND</span><strong>{counts.complete.toLocaleString()}</strong><span className="stat-caption">saved in this CSV, ready to export</span></div>
              <div className="stat-card"><span className="stat-label">{isEnriching ? "REMAINING" : "TO ENRICH"}</span><strong>{remainingCount.toLocaleString()}</strong><span className="stat-caption">{isEnriching ? "in the active job" : "pending or retryable"}</span></div>
              <div className="stat-card progress-stat">
                <span className="stat-label">COMPLETION</span>
                <strong>{jobStatus ? jobPercent : successPercent}<span className="percent-sign">%</span></strong>
                <div className="progress-track"><span style={{ width: `${jobStatus ? jobPercent : successPercent}%` }} /></div>
              </div>
            </div>

            <div className="enrich-bar">
              <div className="enrich-copy">
                <span className={`pulse-dot${isEnriching ? " is-running" : ""}`} />
                <div>
                  <strong>{jobStatus?.status === "paused"
                    ? "Campaign paused"
                    : isEnriching
                      ? (jobStatus?.status === "waiting_for_keys" ? "Waiting for an active key" : "Enrichment running on server")
                      : "Ready to find emails?"}</strong>
                  <span>{hasIncompleteJob && jobStatus
                    ? `${jobStatus?.completed_count ?? 0} of ${jobStatus?.total_count ?? 0} websites complete · safe to leave this page or turn off your computer.`
                    : `About ${estimatedMinutes} min minimum for the remaining rows at the configured shared request rate.`}</span>
                </div>
              </div>
              <div className="enrich-actions">
                {jobStatus?.status === "paused" ? (
                  <button className="button button-primary" onClick={() => void setCampaignPaused("resume")} disabled={isSubmittingJob}>
                    {isSubmittingJob ? "Resuming…" : "Resume campaign"}
                  </button>
                ) : jobStatus && ["queued", "running"].includes(jobStatus.status) ? (
                  <button className="button button-quiet" onClick={() => void setCampaignPaused("pause")} disabled={isSubmittingJob}>
                    {isSubmittingJob ? "Pausing…" : "Pause campaign"}
                  </button>
                ) : null}
                <button
                  className="button button-primary"
                  onClick={() => void enrichRows()}
                  disabled={isEnriching || hasIncompleteJob || isSubmittingJob || remainingCount === 0}
                >
                  {isSubmittingJob ? "Queueing…" : <>Enrich {remainingCount > 0 ? `${remainingCount} rows` : "list"} <span aria-hidden="true">→</span></>}
                </button>
              </div>
            </div>

            <div className="table-toolbar">
              <div className="table-title"><h3>All records</h3><span>{visibleRows.length.toLocaleString()} matching</span></div>
              <div className="table-controls">
                <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search rows" placeholder="Search rows..." value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label>
                <label className="filter-field"><span className="filter-icon" aria-hidden="true">☷</span><select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                  <option value="all">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="running">In progress</option>
                  <option value="complete">Email found</option>
                  <option value="not_found">No email found</option>
                  <option value="failed">Failed</option>
                  <option value="missing_website">Missing website</option>
                </select></label>
                <label className="page-size-field"><span>ROWS</span><select aria-label="Rows per page" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                  {PAGE_SIZE_OPTIONS.map((size) => <option value={size} key={size}>{size}</option>)}
                </select></label>
              </div>
            </div>

            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th className="row-number-head">#</th>
                  {project.headers.slice(0, 5).map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}
                  {project.headers.length > 5 && <th className="more-columns">+{project.headers.length - 5} columns</th>}
                  <th>STATUS</th>
                </tr></thead>
                <tbody>
                  {pageRows.map((row) => {
                    const rowIndex = project.rows.findIndex((candidate) => candidate.id === row.id);
                    return <tr key={row.id}>
                      <td className="row-number">{String(rowIndex + 1).padStart(2, "0")}</td>
                      {project.headers.slice(0, 5).map((_, index) => <td key={index} className={index === project.emailColumnIndex ? "email-cell" : ""}>{index === project.emailColumnIndex && !row.cells[index] ? <span className="placeholder-value">—</span> : row.cells[index] || <span className="placeholder-value">—</span>}</td>)}
                      {project.headers.length > 5 && <td className="more-columns"><span>+{project.headers.length - 5} columns</span></td>}
                      <td><StatusBadge status={row.status} current={false} error={row.error} /></td>
                    </tr>;
                  })}
                  {visibleRows.length === 0 && <tr><td className="empty-row" colSpan={Math.min(project.headers.length, 5) + 2}>No records match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="pagination" aria-label="Table pagination">
              <span className="pagination-summary">
                Showing {visibleRows.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, visibleRows.length)} of {visibleRows.length.toLocaleString()}
              </span>
              <div className="pagination-buttons">
                <button className="page-button" onClick={() => setCurrentPage(1)} disabled={safePage <= 1} aria-label="First page">«</button>
                <button className="page-button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={safePage <= 1} aria-label="Previous page">‹</button>
                <span>Page {safePage} of {pageCount}</span>
                <button className="page-button" onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))} disabled={safePage >= pageCount} aria-label="Next page">›</button>
                <button className="page-button" onClick={() => setCurrentPage(pageCount)} disabled={safePage >= pageCount} aria-label="Last page">»</button>
              </div>
            </div>
            {counts.notFound > 0 && <p className="table-footnote">{counts.notFound} row{counts.notFound === 1 ? "" : "s"} had no public email detected.</p>}
          </section>
        )}

        {notice && <div className="toast toast-success" role="status"><span>✓</span> {notice}<button onClick={() => setNotice("")} aria-label="Dismiss notification">×</button></div>}
        {errorMessage && <div className="toast toast-error" role="alert"><span>!</span> {errorMessage}<button onClick={() => setErrorMessage("")} aria-label="Dismiss error">×</button></div>}
        {!isHydrated && <div className="restore-note">Restoring local workspace…</div>}
        <footer className="footer">
          <span>Made for thoughtful outreach <span className="footer-heart">♥</span></span>
          <span><span className="footer-lock">⌑</span> CSV kept in this browser <span className="muted-separator">·</span> Private server-side worker queue</span>
        </footer>
      </div>
    </main>
  );
}

function StatusBadge({ status, current, error }: { status: RowStatus; current: boolean; error?: string }) {
  const labels: Record<RowStatus, string> = {
    pending: "Pending",
    running: "Enriching",
    complete: "Email found",
    not_found: "Not found",
    failed: "Failed",
    missing_website: "No website",
  };
  return <span className={`status-badge status-${status}`} title={error || undefined}>
    {current && <span className="status-spinner" />}
    {!current && <span className="status-indicator" />}
    {labels[status]}
  </span>;
}
