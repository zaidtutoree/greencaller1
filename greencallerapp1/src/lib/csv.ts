/**
 * Minimal RFC 4180 CSV parser/serialiser used by the CRM page.
 * Handles quoted fields, escaped quotes (""), embedded newlines, CRLF and a UTF-8 BOM.
 * Auto-detects comma / semicolon / tab delimiters from the header line.
 */

export interface ParsedCsv {
  columns: string[];
  rows: string[][];
}

const detectDelimiter = (headerLine: string): string => {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = headerLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
};

export const parseCsv = (text: string): ParsedCsv => {
  const src = text.replace(/^\uFEFF/, "");
  if (!src.trim()) return { columns: [], rows: [] };

  const firstNewline = src.search(/\r?\n/);
  const delimiter = detectDelimiter(firstNewline === -1 ? src : src.slice(0, firstNewline));

  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      records.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // Flush the final record (file may not end with a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  // Drop fully blank lines.
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { columns: [], rows: [] };

  const [header, ...body] = nonEmpty;
  const width = Math.max(header.length, ...body.map((r) => r.length));

  const columns = Array.from({ length: width }, (_, i) => {
    const name = (header[i] ?? "").trim();
    return name || `Column ${i + 1}`;
  });

  const rows = body.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? "").trim()));

  return { columns, rows };
};

const escapeCell = (value: string): string => {
  const v = value ?? "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export const toCsv = (columns: string[], rows: string[][]): string => {
  const lines = [columns.map(escapeCell).join(",")];
  for (const r of rows) {
    lines.push(columns.map((_, i) => escapeCell(r[i] ?? "")).join(","));
  }
  return lines.join("\r\n");
};
