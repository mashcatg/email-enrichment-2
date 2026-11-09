export type RowStatus = "pending" | "running" | "complete" | "not_found" | "failed" | "missing_website";

export interface EnrichmentRow {
  id: string;
  cells: string[];
  status: RowStatus;
  error?: string;
}

export interface EnrichmentProject {
  headers: string[];
  rows: EnrichmentRow[];
  websiteColumnIndex: number;
  emailColumnIndex: number;
  fileName: string;
  updatedAt: number;
  jobId?: string;
}
