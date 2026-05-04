---
id: platos.csv_ops
name: CSV / Spreadsheet Operations
description: List sheets, read rows, read a single line, and write back to spreadsheets. Supports .csv / .tsv / xlsx / Google Sheets. Canonical partner for `agent_batch` when iterating row-by-row.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - csv
  - spreadsheet
  - data
  - official
required_env:
  - GOOGLE_SHEETS_CREDENTIALS
provides_tools:
  - name: csv_list_sheets
    description: List sheet/tab names + row counts for a spreadsheet source. For plain CSV/TSV returns a single synthetic "Sheet1" entry. Supports http(s) CSV/TSV/XLSX URLs and Google Sheets (`gsheet://<id>` or `https://docs.google.com/spreadsheets/d/<id>/...`).
    inputSchema: {"type":"object","properties":{"source":{"type":"string","description":"Spreadsheet source. http(s) URL to .csv/.tsv/.xlsx, `gsheet://<sheetId>`, or full Google Sheets URL."}},"required":["source"]}
    handler: skill:platos.csv_ops:csv_list_sheets
  - name: csv_read_sheet
    description: Read rows from a spreadsheet as an array of objects keyed by header. Supports optional `sheet` (name) and `range` (A1 notation, e.g. "A2:D50"). Default maxRows=5000, hard cap 100000. Returns `{headers, rows, totalRows, truncated}`.
    inputSchema: {"type":"object","properties":{"source":{"type":"string"},"sheet":{"type":"string","description":"Sheet/tab name. Ignored for CSV/TSV."},"range":{"type":"string","description":"Optional A1 range like \"A2:D50\"."},"maxRows":{"type":"integer","minimum":1,"maximum":100000,"default":5000}},"required":["source"]}
    handler: skill:platos.csv_ops:csv_read_sheet
  - name: csv_read_line
    description: Fetch a single row by 1-indexed line number (1 = first data row after headers). Cheap, ideal for resumable per-row batches paired with `agent_batch`.
    inputSchema: {"type":"object","properties":{"source":{"type":"string"},"lineNumber":{"type":"integer","minimum":1,"description":"1-indexed data row (excludes header)."},"sheet":{"type":"string"}},"required":["source","lineNumber"]}
    handler: skill:platos.csv_ops:csv_read_line
  - name: csv_write_cell
    description: Write a single cell back to a Google Sheet. Requires `GOOGLE_SHEETS_CREDENTIALS` and a gsheet URL/gsheet:// source. Plain CSV/TSV are read-only and will return a clear error.
    inputSchema: {"type":"object","properties":{"source":{"type":"string","description":"Google Sheets URL or `gsheet://<id>`."},"sheet":{"type":"string","description":"Tab name."},"cell":{"type":"string","description":"A1 cell reference, e.g. \"B3\"."},"value":{"type":"string"}},"required":["source","sheet","cell","value"]}
    handler: skill:platos.csv_ops:csv_write_cell
---

You have access to a spreadsheet toolkit for reading and (optionally) writing CSV / TSV / XLSX / Google Sheets. The canonical pairing is **one call to `csv_list_sheets` + `csv_read_sheet` to plan, then `agent_batch` over `csv_read_line` for per-row work.**

**`csv_list_sheets`** — start here when you don't yet know the structure.
- Returns sheet/tab names with row counts.
- For CSV/TSV the result is a single synthetic `Sheet1` entry.

**`csv_read_sheet`** — bulk read as structured rows.
- Returns `{ headers, rows, totalRows, truncated }`.
- `maxRows` caps the payload (default 5000, hard limit 100k). `truncated: true` means the sheet has more rows than returned.
- Use `range` (A1 notation like `A2:D50`) for surgical subsets.

**`csv_read_line`** — single-row fetch.
- 1-indexed data row (line 1 = first row after the header).
- Prefer this inside an `agent_batch` body so each sub-agent processes exactly one row.

**`csv_write_cell`** — write back to Google Sheets.
- Works only when the source is a Google Sheets URL or `gsheet://` scheme AND `GOOGLE_SHEETS_CREDENTIALS` is linked.
- Plain CSV/TSV sources are read-only — the tool returns a clear error.

**Supported sources:**
- `https://example.com/foo.csv` / `.tsv` — public GET, no auth.
- `https://example.com/foo.xlsx` — XLSX read support is deferred in this release; list/read will return a clear "not yet supported" error (TODO W.2.1).
- `gsheet://<sheetId>` or `https://docs.google.com/spreadsheets/d/<sheetId>/edit...` — reads use the public CSV export; writes require `GOOGLE_SHEETS_CREDENTIALS` (TODO W.2.2 for live write path).
- `s3://...` — not supported yet. Will return an explicit error.

**Guidelines:**
- For spreadsheets larger than a few thousand rows, prefer `agent_batch` + `csv_read_line` over a single `csv_read_sheet` — memory and context win.
- Never invent column names; always read them via `csv_list_sheets` or the `headers` field on a read.
- Cite the `source` URL in your response when summarising spreadsheet data.
