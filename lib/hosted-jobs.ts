import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const PRIVATE_BUCKET = "enrichment-jobs";

export interface JobInputEntry {
  rowIndex: number;
  website: string;
}

export interface JobResultEntry {
  rowIndex: number;
  email: string;
  status: "complete" | "not_found" | "failed";
  error?: string;
}

export async function uploadPrivateJson(pathname: string, value: unknown): Promise<void> {
  const { error } = await createSupabaseAdminClient().storage
    .from(PRIVATE_BUCKET)
    .upload(pathname, JSON.stringify(value), {
      contentType: "application/json",
      upsert: true,
    });
  if (error) {
    throw new Error(`Could not save private job data in Supabase Storage: ${error.message}`);
  }
}

export async function downloadPrivateJson<T>(pathname: string): Promise<T> {
  const { data, error } = await createSupabaseAdminClient().storage.from(PRIVATE_BUCKET).download(pathname);
  if (error) {
    throw new Error(`Could not read private job data from Supabase Storage: ${error.message}`);
  }
  try {
    return JSON.parse(await data.text()) as T;
  } catch (error) {
    throw new Error(`Private job file is not valid JSON: ${pathname}`, { cause: error });
  }
}

export async function deletePrivateJson(pathnames: string | string[]): Promise<void> {
  const paths = typeof pathnames === "string" ? [pathnames] : pathnames;
  const storage = createSupabaseAdminClient().storage.from(PRIVATE_BUCKET);
  for (let offset = 0; offset < paths.length; offset += 500) {
    const { error } = await storage.remove(paths.slice(offset, offset + 500));
    if (error) {
      throw new Error(`Could not clean up private job data in Supabase Storage: ${error.message}`);
    }
  }
}

export async function listPrivateJson(prefix: string): Promise<string[]> {
  const storage = createSupabaseAdminClient().storage.from(PRIVATE_BUCKET);
  const paths: string[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await storage.list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      throw new Error(`Could not list private job results in Supabase Storage: ${error.message}`);
    }
    paths.push(...data.filter((entry) => entry.id).map((entry) => `${prefix}/${entry.name}`));
    if (data.length < pageSize) break;
  }
  return paths;
}
