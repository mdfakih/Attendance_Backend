import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pdfmake, { type DocDefinition } from 'pdfmake';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('pdfmake/package.json')), 'build', 'fonts', 'Roboto');

pdfmake.setFonts({
  Roboto: {
    normal: join(fontDir, 'Roboto-Regular.ttf'),
    bold: join(fontDir, 'Roboto-Medium.ttf'),
    italics: join(fontDir, 'Roboto-Italic.ttf'),
    bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
  },
});

export const PDF_MIME = 'application/pdf';

export function renderPdf(definition: DocDefinition): Promise<Buffer> {
  return pdfmake
    .createPdf({ defaultStyle: { font: 'Roboto', fontSize: 9 }, pageMargins: [24, 28, 24, 28], ...definition })
    .getBuffer();
}

export interface PdfTable {
  readonly title: string;
  readonly subtitle?: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<string | number>>;
  readonly widths?: ReadonlyArray<string | number>;
  readonly landscape?: boolean;
}

/** Simple table report with a title line and page numbers. */
export function tablePdf(spec: PdfTable): Promise<Buffer> {
  return renderPdf({
    pageOrientation: spec.landscape ? 'landscape' : 'portrait',
    pageSize: 'A4',
    content: [
      { text: spec.title, fontSize: 14, bold: true, margin: [0, 0, 0, 2] },
      ...(spec.subtitle ? [{ text: spec.subtitle, fontSize: 9, color: '#555555', margin: [0, 0, 0, 10] }] : []),
      {
        table: {
          headerRows: 1,
          widths: spec.widths ? [...spec.widths] : spec.headers.map(() => '*'),
          body: [spec.headers.map((h) => ({ text: h, bold: true, fillColor: '#f0f0f0' })), ...spec.rows.map((r) => r.map((c) => String(c)))],
        },
        layout: 'lightHorizontalLines',
      },
    ],
    footer: (page: number, pages: number) => ({ text: `Page ${page} of ${pages}`, alignment: 'center', fontSize: 8, color: '#777777' }),
  });
}
