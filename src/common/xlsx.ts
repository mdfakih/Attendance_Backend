import ExcelJS from 'exceljs';

export interface SheetColumn {
  readonly header: string;
  readonly key: string;
  readonly width?: number;
}

export interface SheetSpec {
  readonly name: string;
  readonly columns: readonly SheetColumn[];
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Optional: list validations, keyed by column key → named range formula (e.g. "=Lists!$A$2:$A$50"). */
  readonly listValidations?: Readonly<Record<string, string>>;
  readonly validationRows?: number;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Builds an .xlsx with a bold, frozen header row per sheet. */
export async function buildXlsx(sheets: readonly SheetSpec[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 2) }));
    sheet.getRow(1).font = { bold: true };
    sheet.addRows(spec.rows.map((r) => ({ ...r })));
    if (spec.listValidations) {
      const lastRow = spec.validationRows ?? 1000;
      spec.columns.forEach((column, index) => {
        const formula = spec.listValidations?.[column.key];
        if (!formula) return;
        for (let row = 2; row <= lastRow; row += 1) {
          sheet.getCell(row, index + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [formula] };
        }
      });
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

/** Reads the first worksheet into header-keyed rows of plain strings. */
export async function readXlsx(buffer: Buffer): Promise<{ headers: string[]; rows: Array<{ rowNo: number; values: string[] }> }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { headers: [], rows: [] };
  }
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map((v) => cellText(v));
  const rows: Array<{ rowNo: number; values: string[] }> = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
    if (rowNo === 1) return;
    const values = headers.map((_, i) => cellText(row.getCell(i + 1).value));
    if (values.some((v) => v !== '')) {
      rows.push({ rowNo, values });
    }
  });
  return { headers, rows };
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { text?: string; result?: unknown; richText?: Array<{ text: string }>; hyperlink?: string };
    if (v.richText) return v.richText.map((r) => r.text).join('').trim();
    if (v.text !== undefined) return String(v.text).trim();
    if (v.result !== undefined) return cellText(v.result);
    return '';
  }
  return String(value).trim();
}
