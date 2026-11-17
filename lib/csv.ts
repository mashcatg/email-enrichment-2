import { normalizeEmailAddress } from "./email";

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);

  if (inQuotes) throw new Error("The CSV has an unclosed quoted field.");
  return rows;
}

export function stringifyCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const escaped = value.replace(/"/g, '""');
          return /[",\r\n]/.test(value) ? `"${escaped}"` : escaped;
        })
        .join(","),
    )
    .join("\r\n");
}

export function generateVerifiedCsv(enrichedCsv: string, verifiedCsv: string) {
  const enrichedRows = parseCsv(enrichedCsv);
  const verifiedRows = parseCsv(verifiedCsv);

  if (enrichedRows.length < 2) {
    throw new Error("The enriched CSV needs a header row and at least one data row.");
  }
  if (verifiedRows.length < 2) {
    throw new Error("The verified CSV needs a header row and at least one data row.");
  }

  const emailColumn = (headers: string[]) =>
    headers.findIndex((header) => header.trim().toLowerCase() === "email");
  const enrichedEmailIndex = emailColumn(enrichedRows[0]);
  const verifiedEmailIndex = emailColumn(verifiedRows[0]);
  if (enrichedEmailIndex < 0) {
    throw new Error('No "email" column was found in the enriched CSV.');
  }
  if (verifiedEmailIndex < 0) {
    throw new Error('No "email" column was found in the verified CSV.');
  }
  const verifiedSafeToSendIndex = verifiedRows[0].findIndex(
    (header) => header.trim().toLowerCase() === "safe to send",
  );
  if (verifiedSafeToSendIndex < 0) {
    throw new Error('No "Safe to send" column was found in the verified CSV.');
  }

  const headers = [...enrichedRows[0]];
  let safeToSendIndex = headers.findIndex(
    (header) => header.trim().toLowerCase() === "safe to send",
  );
  if (safeToSendIndex < 0) {
    safeToSendIndex = headers.length;
    headers.push("Safe to send");
  }

  const verifiedEmails = new Set(
    verifiedRows.slice(1)
      .filter((row) => row[verifiedSafeToSendIndex]?.trim().toLowerCase() === "yes")
      .map((row) => normalizeEmailAddress(row[verifiedEmailIndex] ?? ""))
      .filter((email): email is string => Boolean(email)),
  );
  const rows = enrichedRows.slice(1).flatMap((row) => {
    const email = normalizeEmailAddress(row[enrichedEmailIndex] ?? "");
    if (!email || !verifiedEmails.has(email)) return [];

    const matchedRow = Array.from({ length: headers.length }, (_, index) => row[index] ?? "");
    matchedRow[safeToSendIndex] = "Yes";
    return [matchedRow];
  });

  return { headers, rows };
}
