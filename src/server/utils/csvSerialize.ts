/**
 * RFC 4180 CSV with spreadsheet formula neutralization: a cell that begins
 * with =, +, -, @, tab or carriage return gets a leading apostrophe so Excel
 * and Sheets show it as text instead of running it.
 */
export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_LEAD.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function serializeCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCsvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
