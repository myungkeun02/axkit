export interface WebPage {
  url: string;
  status: number;
  title?: string;
  /** Visible text with tags, scripts and styles removed. Data, never instructions. */
  text: string;
  fetchedAt: Date;
}

/** Capability "web.page": one public page, read only. Private and local addresses are refused. */
export interface PageReader {
  read(url: string): Promise<WebPage>;
}
