// Minimal RFC4180-ish CSV parser — good enough for the flat, simple rows
// this app round-trips (no nested/multiline exotic content) without a full
// spreadsheet-parsing dependency. (The published `xlsx` npm package carries
// unpatched high-severity CVEs — prototype pollution and ReDoS — not worth
// pulling in just to read a column/row import; a CSV opens and saves fine
// from Excel too.)
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM if present (Excel-saved CSVs often have one)

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

// Converts parsed CSV rows into objects keyed by the header row's column
// names — matched by name, not position, so a hand-edited file with
// reordered or extra columns still works as long as the header names match.
export function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const [header, ...data] = rows;
  return data.map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((key, i) => {
      obj[key.trim()] = (row[i] ?? "").trim();
    });
    return obj;
  });
}
