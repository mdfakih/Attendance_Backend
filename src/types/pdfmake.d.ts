/** Minimal typings for pdfmake 0.3's server build (the @types package targets the browser API). */
declare module 'pdfmake' {
  export interface PdfOutput {
    getBuffer(): Promise<Buffer>;
    getStream(): Promise<NodeJS.ReadableStream>;
  }
  export type FontDictionary = Record<string, { normal: string; bold: string; italics: string; bolditalics: string }>;
  /** Document definition; kept loose on purpose. */
  export type DocDefinition = Record<string, unknown> & { content: unknown };

  interface PdfMake {
    setFonts(fonts: FontDictionary): void;
    addFonts(fonts: FontDictionary): void;
    createPdf(definition: DocDefinition, options?: Record<string, unknown>): PdfOutput;
  }
  const pdfmake: PdfMake;
  export default pdfmake;
}
