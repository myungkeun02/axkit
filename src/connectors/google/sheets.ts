import type { SheetInfo, SheetTab, SheetValues, SheetsReader, SheetsWriter } from '../../core/contracts/workspace.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_CELL_CHARS = 1_000;

function sheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? init : { ...init, signal };
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, MAX_CELL_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function toTab(raw: unknown): SheetTab | undefined {
  if (!isRecord(raw) || !isRecord(raw.properties)) return undefined;
  const props = raw.properties;
  if (typeof props.title !== 'string') return undefined;
  const grid = isRecord(props.gridProperties) ? props.gridProperties : {};
  return {
    title: props.title,
    rows: typeof grid.rowCount === 'number' ? grid.rowCount : 0,
    columns: typeof grid.columnCount === 'number' ? grid.columnCount : 0,
  };
}

/** A tab name with spaces or symbols must be quoted in A1 notation ('내 시트'!A1). */
export function quoteTab(title: string): string {
  return /^[\p{L}\p{N}_]+$/u.test(title) ? title : `'${title.replaceAll("'", "''")}'`;
}

/** Google Sheets values API. Writes use RAW input so text that looks like a formula stays text. */
export class GoogleSheets implements SheetsReader, SheetsWriter {
  constructor(private readonly request: GoogleRequestFn) {}

  async info(id: string, signal?: AbortSignal): Promise<SheetInfo> {
    const url = new URL(`${SHEETS}/${encodeURIComponent(id)}`);
    url.searchParams.set('fields', 'properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))');
    const raw = await this.request<unknown>(url.toString(), withSignal({}, signal));
    const record = isRecord(raw) ? raw : {};
    const title = isRecord(record.properties) && typeof record.properties.title === 'string' ? record.properties.title : '';
    const tabs = Array.isArray(record.sheets) ? record.sheets.map(toTab).filter((tab) => tab !== undefined) : [];
    return { id, title, tabs, url: sheetUrl(id) };
  }

  async read(
    id: string,
    range: string | undefined,
    caps: { rows: number; columns: number },
    signal?: AbortSignal,
  ): Promise<SheetValues> {
    let target = range;
    if (target === undefined || target.trim() === '') {
      const first = (await this.info(id, signal)).tabs[0];
      if (first === undefined) return { range: '', rows: [], truncated: false };
      target = quoteTab(first.title);
    }
    const url = new URL(`${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(target)}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
    const raw = await this.request<{ range?: unknown; values?: unknown }>(url.toString(), withSignal({}, signal));
    const values = Array.isArray(raw.values) ? raw.values : [];
    let truncated = values.length > caps.rows;
    const rows = values.slice(0, caps.rows).map((row) => {
      const cells = Array.isArray(row) ? row : [];
      if (cells.length > caps.columns) truncated = true;
      return cells.slice(0, caps.columns).map(cellText);
    });
    return { range: typeof raw.range === 'string' ? raw.range : target, rows, truncated };
  }

  async append(
    id: string,
    range: string,
    rows: readonly (readonly string[])[],
    signal?: AbortSignal,
  ): Promise<{ updatedRange: string; rows: number }> {
    const url = new URL(`${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append`);
    url.searchParams.set('valueInputOption', 'RAW');
    url.searchParams.set('insertDataOption', 'INSERT_ROWS');
    const result = await this.request<{ updates?: { updatedRange?: unknown; updatedRows?: unknown } }>(
      url.toString(),
      withSignal({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values: rows }) }, signal),
    );
    const updates = result.updates ?? {};
    return {
      updatedRange: typeof updates.updatedRange === 'string' ? updates.updatedRange : range,
      rows: typeof updates.updatedRows === 'number' ? updates.updatedRows : rows.length,
    };
  }

  async update(
    id: string,
    range: string,
    rows: readonly (readonly string[])[],
    signal?: AbortSignal,
  ): Promise<{ updatedRange: string; cells: number }> {
    const url = new URL(`${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`);
    url.searchParams.set('valueInputOption', 'RAW');
    const result = await this.request<{ updatedRange?: unknown; updatedCells?: unknown }>(
      url.toString(),
      withSignal({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values: rows }) }, signal),
    );
    return {
      updatedRange: typeof result.updatedRange === 'string' ? result.updatedRange : range,
      cells: typeof result.updatedCells === 'number' ? result.updatedCells : rows.reduce((sum, row) => sum + row.length, 0),
    };
  }
}
