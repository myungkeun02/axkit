export interface RecognizedText {
  text: string;
  pages: number;
  /** `pdf-text`: the PDF had a text layer; `vision`: characters were recognized from pixels on this Mac. */
  method: 'pdf-text' | 'vision';
}

/** Capability "ocr.text": text from a local image or PDF, recognized on this machine (nothing is uploaded). */
export interface TextRecognizer {
  recognize(path: string, opts?: { languages?: readonly string[]; maxPages?: number }): Promise<RecognizedText>;
}
