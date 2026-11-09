"use client";

import { useCallback, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface AnalyticsData {
  jobs: Array<{
    id: string;
    file_name: string;
    total_count: number;
    completed_count: number;
    found_count: number;
    not_found_count: number;
    failed_count: number;
    status: string;
    created_at: string;
    updated_at: string;
  }>;
  keys: Array<{
    key_index: number;
    state: "active" | "paused";
    error: string | null;
    updated_at: string;
    request_count: number;
    configured: boolean;
  }>;
  notifications: Array<{
    id: string;
    key_index: number;
    job_id: string | null;
    message: string;
    created_at: string;
    resolved_at: string | null;
  }>;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/analytics", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load analytics.");
      setData(result);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load analytics.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    try {
      const supabase = createSupabaseBrowserClient();
      supabase.auth.getUser().then(({ data: userData }) => {
        if (!active) return;
        const authorized = userData.user?.email?.toLowerCase() === "mashcatg@gmail.com";
        setIsAuthenticated(authorized);
        if (authorized) void refresh();
      }).catch((authError: unknown) => {
        if (active) setError(authError instanceof Error ? authError.message : "Could not verify sign-in.");
      });
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Supabase authentication is not configured.");
    }
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const resolve = async (id: string) => {
    try {
      const response = await fetch(`/api/notifications/${id}/resolve`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not re-enable this key.");
      await refresh();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "Could not re-enable this key.");
    }
  };

  if (!isAuthenticated) {
    return <main className="analytics-shell"><p>Sign in with the authorized account to view analytics. <a href="/">Go to sign in</a></p></main>;
  }

  const totals = data?.jobs.reduce((result, job) => ({
    websites: result.websites + job.total_count,
    completed: result.completed + job.completed_count,
    found: result.found + job.found_count,
    failed: result.failed + job.failed_count,
  }), { websites: 0, completed: 0, found: 0, failed: 0 });

  return (
    <main className="analytics-shell">
      <header className="topbar">
        <a className="brand" href="/"><span className="brand-mark">e</span><span>enrich<span className="brand-dot">.</span></span></a>
        <div className="topbar-right"><a className="help-link" href="/">← Enrichment list</a></div>
      </header>
      <div className="analytics-content">
        <div className="analytics-title">
          <div><div className="eyebrow"><span className="eyebrow-line" /> BACKGROUND PROCESSING</div><h1>Worker analytics</h1></div>
          <button className="button button-quiet" onClick={() => void refresh()}>Refresh</button>
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <section className="analytics-cards">
          <div className="stat-card"><span className="stat-label">WEBSITES QUEUED</span><strong>{totals?.websites ?? "—"}</strong><span className="stat-caption">across recent jobs</span></div>
          <div className="stat-card"><span className="stat-label">PROCESSED</span><strong>{totals?.completed ?? "—"}</strong><span className="stat-caption">websites visited once each</span></div>
          <div className="stat-card"><span className="stat-label">EMAILS FOUND</span><strong>{totals?.found ?? "—"}</strong><span className="stat-caption">results merged after job completion</span></div>
          <div className="stat-card"><span className="stat-label">FAILED ROWS</span><strong>{totals?.failed ?? "—"}</strong><span className="stat-caption">website-level failures</span></div>
        </section>

        <section className="analytics-panel">
          <div className="analytics-panel-heading"><h2>Firecrawl API key health</h2><span>Keys pause for authentication, billing, rate-limit, and service errors</span></div>
          <div className="key-grid">
            {data?.keys.map((key) => (
              <article className={`key-card ${!key.configured ? "key-unconfigured" : `key-${key.state}`}`} key={key.key_index}>
                <div><strong>Key {key.key_index}</strong><span>{!key.configured ? "Not configured" : key.state}</span></div>
                <small>{key.request_count.toLocaleString()} assigned requests</small>
                {key.error && <p>{key.error}</p>}
              </article>
            ))}
          </div>
        </section>

        <section className="analytics-panel">
          <div className="analytics-panel-heading"><h2>Key notifications</h2><span>Resolve an alert to re-enable its key after reviewing the issue</span></div>
          {!data?.notifications.length && <p className="analytics-empty">No key alerts have been recorded.</p>}
          {data?.notifications.map((item) => (
            <article className={`notification-row${item.resolved_at ? " is-resolved" : ""}`} key={item.id}>
              <div><strong>Key {item.key_index} · {item.resolved_at ? "Resolved" : "Paused"}</strong><p>{item.message}</p><small>{new Date(item.created_at).toLocaleString()}</small></div>
              {!item.resolved_at && <button className="button button-quiet" onClick={() => void resolve(item.id)}>Resolved · re-enable</button>}
            </article>
          ))}
        </section>

        <section className="analytics-panel">
          <div className="analytics-panel-heading"><h2>Recent enrichment jobs</h2><span>Input URLs and email results are not stored in Supabase.</span></div>
          {!data?.jobs.length && <p className="analytics-empty">No jobs yet. Upload a CSV to start one.</p>}
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead><tr><th>File</th><th>Status</th><th>Progress</th><th>Found</th><th>Not found</th><th>Failed</th><th>Created</th></tr></thead>
              <tbody>{data?.jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.file_name}</td><td><span className={`job-badge job-${job.status}`}>{job.status.replaceAll("_", " ")}</span></td>
                  <td>{job.completed_count} / {job.total_count}</td><td>{job.found_count}</td><td>{job.not_found_count}</td><td>{job.failed_count}</td>
                  <td>{new Date(job.created_at).toLocaleString()}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
        <footer className="footer"><span>Secure worker analytics</span><span>Job inputs and results use private Supabase Storage.</span></footer>
      </div>
    </main>
  );
}
