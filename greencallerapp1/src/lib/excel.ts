/**
 * Excel import for the CRM page.
 *
 * A single worksheet often holds several unrelated tables laid out side by side or
 * one under another, separated by blank rows/columns. `parseExcelTables` finds each
 * "island" of filled cells, treats it as its own table and returns them all, so one
 * upload can produce several CRM lists.
 *
 * Detection: filled cells that touch (including diagonally) belong to the same island;
 * islands whose bounding boxes overlap are merged. A lone cell directly above a table
 * (e.g. a bold title like "Plumbers – London") is used as the table's name rather than
 * as its header row.
 */

export interface ExcelTable {
  /** Worksheet the table came from. */
  sheet: string;
  /** Title cell found above the table, if any. */
  title: string | null;
  columns: string[];
  rows: string[][];
}

const MIN_FILLED_CELLS = 2;

const isFilled = (v: unknown) => String(v ?? "").trim() !== "";

interface Box {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

const boxesTouch = (a: Box, b: Box) =>
  a.r0 <= b.r1 + 1 && b.r0 <= a.r1 + 1 && a.c0 <= b.c1 + 1 && b.c0 <= a.c1 + 1;

/** Flood-fill islands of filled cells and return their bounding boxes, merged where they touch. */
const findIslands = (grid: string[][]): Box[] => {
  const height = grid.length;
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  if (height === 0 || width === 0) return [];

  const seen = new Uint8Array(height * width);
  const filled = (r: number, c: number) =>
    r >= 0 && r < height && c >= 0 && c < width && isFilled(grid[r][c]);

  let boxes: Box[] = [];
  const stack: number[] = [];

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const id = r * width + c;
      if (seen[id] || !filled(r, c)) continue;
      const box: Box = { r0: r, r1: r, c0: c, c1: c };
      let count = 0;
      stack.push(id);
      seen[id] = 1;
      while (stack.length) {
        const cur = stack.pop() as number;
        const cr = Math.floor(cur / width);
        const cc = cur % width;
        count++;
        if (cr < box.r0) box.r0 = cr;
        if (cr > box.r1) box.r1 = cr;
        if (cc < box.c0) box.c0 = cc;
        if (cc > box.c1) box.c1 = cc;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nr = cr + dr;
            const nc = cc + dc;
            if (!filled(nr, nc)) continue;
            const nid = nr * width + nc;
            if (seen[nid]) continue;
            seen[nid] = 1;
            stack.push(nid);
          }
        }
      }
      if (count >= MIN_FILLED_CELLS) boxes.push(box);
    }
  }

  // Merge boxes that overlap or touch until nothing changes.
  let merged = true;
  while (merged) {
    merged = false;
    const next: Box[] = [];
    for (const box of boxes) {
      const hit = next.find((b) => boxesTouch(b, box));
      if (hit) {
        hit.r0 = Math.min(hit.r0, box.r0);
        hit.r1 = Math.max(hit.r1, box.r1);
        hit.c0 = Math.min(hit.c0, box.c0);
        hit.c1 = Math.max(hit.c1, box.c1);
        merged = true;
      } else {
        next.push({ ...box });
      }
    }
    boxes = next;
  }

  // Top-to-bottom, then left-to-right, so the order matches how the sheet reads.
  return boxes.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
};

/** Turn one bounding box of the grid into a table with header + rows. */
const boxToTable = (grid: string[][], box: Box, sheet: string): ExcelTable | null => {
  const cell = (r: number, c: number) => String(grid[r]?.[c] ?? "").trim();
  const rowCells = (r: number) => Array.from({ length: box.c1 - box.c0 + 1 }, (_, i) => cell(r, box.c0 + i));
  const filledCount = (cells: string[]) => cells.filter((v) => v !== "").length;

  let headerRow = box.r0;
  let title: string | null = null;

  // A single filled cell on the first row, with a wider row beneath it, is a title.
  const first = rowCells(box.r0);
  if (box.r1 - box.r0 >= 2 && box.c1 > box.c0 && filledCount(first) === 1 && filledCount(rowCells(box.r0 + 1)) >= 2) {
    title = first.find((v) => v !== "") ?? null;
    headerRow = box.r0 + 1;
  }

  const header = rowCells(headerRow);
  const body: string[][] = [];
  for (let r = headerRow + 1; r <= box.r1; r++) {
    const cells = rowCells(r);
    if (filledCount(cells) > 0) body.push(cells);
  }

  // Drop columns that have no header and no values at all.
  const keep = header.map((h, i) => h !== "" || body.some((row) => row[i] !== ""));
  const columns = header
    .map((h, i) => (h !== "" ? h : `Column ${i + 1}`))
    .filter((_, i) => keep[i]);
  const rows = body.map((row) => row.filter((_, i) => keep[i]));

  if (columns.length === 0) return null;
  return { sheet, title, columns, rows };
};

/** Read every table from every worksheet of an .xlsx/.xls file. */
export const parseExcelTables = async (data: ArrayBuffer): Promise<ExcelTable[]> => {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(data, { type: "array", cellDates: true, dense: false });
  const tables: ExcelTable[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    // header:1 → array of arrays; raw:false → use Excel's displayed text (keeps phone numbers,
    // leading zeros and date formatting as the user sees them).
    const grid = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "", blankrows: true });
    for (const box of findIslands(grid)) {
      const table = boxToTable(grid, box, sheetName);
      if (table) tables.push(table);
    }
  }

  return tables;
};

export const isExcelFile = (file: File) =>
  /\.(xlsx|xlsm|xls)$/i.test(file.name) ||
  file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
  file.type === "application/vnd.ms-excel";
