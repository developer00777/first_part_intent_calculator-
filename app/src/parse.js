// Reads an uploaded CSV / TSV / TXT / XLSX / XLS buffer into { headers, rows }.
import Papa from "papaparse";
import * as XLSX from "xlsx";

export const ALLOWED_EXT = ["csv", "tsv", "txt", "xlsx", "xls"];

export function extOf(name) {
  return String(name || "").split(".").pop().toLowerCase();
}

export function parseTable(name, buf) {
  const ext = extOf(name);
  let rows;
  if (ext === "xlsx" || ext === "xls") {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true, dense: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // raw:true keeps real Date objects and numbers, so dates are never re-formatted ambiguously.
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: false });
  } else {
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const res = Papa.parse(text, { skipEmptyLines: "greedy", delimiter: ext === "tsv" ? "\t" : "" });
    rows = res.data;
  }
  // Some exports put a title row above the real header: use the first row with 2+ filled cells.
  let h = 0;
  while (h < Math.min(rows.length, 10) && rows[h].filter((v) => String(v ?? "").trim() !== "").length < 2) h++;
  const headers = (rows[h] || []).map((v) => String(v ?? "").trim());
  const body = rows.slice(h + 1).filter((r) => r.some((v) => String(v ?? "").trim() !== ""));
  return { headers, rows: body };
}
