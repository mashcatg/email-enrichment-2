"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseCsv, stringifyCsv } from "@/lib/csv";
import { isValidEmailAddress } from "@/lib/email";
import { findWebsiteEmail } from "@/lib/firecrawl";
import { deleteProject, readProject, requestPersistentStorage, writeProject } from "@/lib/storage";
import type { EnrichmentProject, EnrichmentRow, RowStatus } from "@/lib/types";

type StatusFilter = "all" | RowStatus;

export default function Home() {
  const [project, setProject] = useState<EnrichmentProject | null>(null);
  const projectRef = useRef<EnrichmentProject | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [isDragging, setIsDragging] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [currentRowId, setCurrentRowId] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const updateRow = useCallback(async (id: string, patch: Partial<EnrichmentRow>) => {
    const current = projectRef.current;
    if (!current) return;
    const next = {
      ...current,
      updatedAt: Date.now(),
      rows: current.rows.map((row) => row.id === id ? { ...row, ...patch } : row),
    };
    await save(next);
  }, [save]);

  const enrichRows = async () => {
    const current = projectRef.current;
    if (!current || !apiKey.trim() || isEnriching) return;
    const targets = current.rows.filter((row) => ["pending", "failed", "not_found"].includes(row.status));
    if (targets.length === 0) {
      setNotice("There are no rows ready to enrich.");
      return;
    }
    setIsEnriching(true);
    setErrorMessage("");
    setNotice("");
    let succeeded = 0;
    let failed = 0;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const row = targets[index];
        setCurrentRowId(row.id);
        setProgressMessage(`Website ${index + 1} of ${targets.length}`);
        const projectNow = projectRef.current;
        if (!projectNow) break;
        const currentRow = projectNow.rows.find((candidate) => candidate.id === row.id);
        if (!currentRow) continue;
        const website = currentRow.cells[projectNow.websiteColumnIndex]?.trim();
        if (!website) {
          await updateRow(row.id, { status: "missing_website", error: undefined });
          continue;
        }
        await updateRow(row.id, { status: "running", error: undefined });
        try {
          const email = await findWebsiteEmail(website, apiKey.trim(), setProgressMessage);
          const latest = projectRef.current;
          if (latest) {
            const cells = [...(latest.rows.find((candidate) => candidate.id === row.id)?.cells ?? currentRow.cells)];
            cells[latest.emailColumnIndex] = email ?? "";
            await updateRow(row.id, { cells, status: email ? "complete" : "not_found" });
          }
          succeeded += 1;
        } catch (error) {
          failed += 1;
          await updateRow(row.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        }
      }
      setNotice(`Enrichment finished. ${succeeded} processed${failed ? `, ${failed} failed` : ""}.`);
    } finally {
      setIsEnriching(false);
      setCurrentRowId(null);
      setProgressMessage("");
    }
  };

  const exportCsv = () => {
    if (!project) return;
    const content = stringifyCsv([project.headers, ...project.rows.map((row) => row.cells)]);
    const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = project.fileName.replace(/\.csv$/i, "") + "-enriched.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Your enriched CSV has been exported. Your local project is still saved.");
  };

  const clearProject = async () => {
    if (!window.confirm("Remove this CSV and its saved results from this browser? This cannot be undone.")) return;
    try {
      await deleteProject();
      projectRef.current = null;
      setProject(null);
      setNotice("The saved project was removed from this browser.");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not clear the saved project.");
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Enrich home">
          <span className="brand-mark">e</span>
          <span>enrich<span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-right">
          <span className="local-pill"><span className="local-dot" /> Local workspace</span>
          <a className="help-link" href="https://docs.firecrawl.dev/" target="_blank" rel="noreferrer">Firecrawl docs <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <div className="workspace">
        <section className="intro">
          <div className="eyebrow"><span className="eyebrow-line" /> EMAIL ENRICHMENT</div>
          <h1>Find the right<br /><span>way to reach them.</span></h1>
          <p>Bring your website list. We’ll find the best public contact email and add it to your CSV.</p>
        </section>

        <section className="setup-card" aria-label="Enrichment setup">
          <div className="section-heading">
            <div className="step-number">01</div>
            <div>
              <h2>Connect your scraper</h2>
              <p>Your key is used only in this browser session.</p>
            </div>
          </div>
          <label className="field-label" htmlFor="api-key">FIRECRAWL API KEY</label>
          <div className="api-input-wrap">
            <span className="key-icon" aria-hidden="true">⌑</span>
            <input id="api-key" type="password" autoComplete="off" placeholder="fc-••••••••••••••••••••••••" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            <span className="session-tag">SESSION ONLY</span>
          </div>
          <p className="privacy-note"><span aria-hidden="true">↗</span> Calls go directly from your browser to Firecrawl. No app server or database.</p>
        </section>

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
              <small>CSV files only · Your data never leaves this browser except for website URLs sent to Firecrawl</small>
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
                <button className="button button-quiet" onClick={clearProject} disabled={isEnriching}>Start over</button>
                <button className="button button-export" onClick={exportCsv}><span aria-hidden="true">↓</span> Export CSV</button>
              </div>
            </div>

            <div className="stats-grid">
              <div className="stat-card"><span className="stat-label">TOTAL ROWS</span><strong>{counts.total.toLocaleString()}</strong><span className="stat-caption">in your list</span></div>
              <div className="stat-card"><span className="stat-label">EMAILS FOUND</span><strong>{counts.complete.toLocaleString()}</strong><span className="stat-caption">ready to export</span></div>
              <div className="stat-card"><span className="stat-label">TO ENRICH</span><strong>{counts.pending.toLocaleString()}</strong><span className="stat-caption">pending or retryable</span></div>
              <div className="stat-card progress-stat">
                <span className="stat-label">COMPLETION</span>
                <strong>{successPercent}<span className="percent-sign">%</span></strong>
                <div className="progress-track"><span style={{ width: `${successPercent}%` }} /></div>
              </div>
            </div>

            <div className="enrich-bar">
              <div className="enrich-copy">
                <span className={`pulse-dot${isEnriching ? " is-running" : ""}`} />
                <div>
                  <strong>{isEnriching ? "Enrichment in progress" : "Ready to find emails?"}</strong>
                  <span>{isEnriching ? `${progressMessage} · Your progress saves automatically` : "Full page, including header and footer · paced to 10 requests/minute with automatic retries."}</span>
                </div>
              </div>
              <button className="button button-primary" onClick={() => void enrichRows()} disabled={!apiKey.trim() || isEnriching || counts.pending === 0}>
                {isEnriching ? <><span className="spinner" /> Working…</> : <>Enrich {counts.pending > 0 ? `${counts.pending} rows` : "list"} <span aria-hidden="true">→</span></>}
              </button>
            </div>
            {!apiKey.trim() && <p className="key-reminder">Add your Firecrawl API key above to start enriching.</p>}

            <div className="table-toolbar">
              <div className="table-title"><h3>All records</h3><span>{visibleRows.length.toLocaleString()} shown</span></div>
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
                  {visibleRows.slice(0, 100).map((row) => {
                    const rowIndex = project.rows.findIndex((candidate) => candidate.id === row.id);
                    return <tr key={row.id}>
                      <td className="row-number">{String(rowIndex + 1).padStart(2, "0")}</td>
                      {project.headers.slice(0, 5).map((_, index) => <td key={index} className={index === project.emailColumnIndex ? "email-cell" : ""}>{index === project.emailColumnIndex && !row.cells[index] ? <span className="placeholder-value">—</span> : row.cells[index] || <span className="placeholder-value">—</span>}</td>)}
                      {project.headers.length > 5 && <td className="more-columns"><span>+{project.headers.length - 5} columns</span></td>}
                      <td><StatusBadge status={row.status} current={row.id === currentRowId} error={row.error} /></td>
                    </tr>;
                  })}
                  {visibleRows.length === 0 && <tr><td className="empty-row" colSpan={Math.min(project.headers.length, 5) + 2}>No records match these filters.</td></tr>}
                </tbody>
              </table>
              {visibleRows.length > 100 && <div className="table-footer">Showing first 100 of {visibleRows.length.toLocaleString()} matching rows. Export includes all records.</div>}
            </div>
            {counts.notFound > 0 && <p className="table-footnote">{counts.notFound} row{counts.notFound === 1 ? "" : "s"} had no public email detected.</p>}
          </section>
        )}

        {notice && <div className="toast toast-success" role="status"><span>✓</span> {notice}<button onClick={() => setNotice("")} aria-label="Dismiss notification">×</button></div>}
        {errorMessage && <div className="toast toast-error" role="alert"><span>!</span> {errorMessage}<button onClick={() => setErrorMessage("")} aria-label="Dismiss error">×</button></div>}
        {!isHydrated && <div className="restore-note">Restoring local workspace…</div>}
        <footer className="footer">
          <span>Made for thoughtful outreach <span className="footer-heart">♥</span></span>
          <span><span className="footer-lock">⌑</span> Saved privately in this browser <span className="muted-separator">·</span> No account needed</span>
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
