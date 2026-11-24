import { lookup as dnsLookup } from 'node:dns/promises';
import type { PageReader, WebPage } from '../../core/contracts/index.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { Lookup } from './address.js';
import { assertPublicUrl } from './address.js';
import type { HtmlText } from './html-text.js';
import { htmlToText } from './html-text.js';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; ax-kit/0.1; personal assistant)';
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const ALLOWED_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'application/json']);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export const defaultLookup: Lookup = async (host) => {
  const records = await dnsLookup(host, { all: true });
  return records.map((record) => record.address);
};

export interface WebPageReaderOptions {
  fetch?: typeof fetch;
  lookup?: Lookup;
  clock: Clock;
}

async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const room = MAX_BYTES - total;
      if (room <= 0) break;
      const take = value.length <= room ? value : value.subarray(0, room);
      chunks.push(take);
      total += take.length;
      if (take.length < value.length) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    }
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Reads one public page. Every hop is checked before a request goes out. */
export class WebPageReader implements PageReader {
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: Lookup;
  private readonly clock: Clock;

  constructor(options: WebPageReaderOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.lookup = options.lookup ?? defaultLookup;
    this.clock = options.clock;
  }

  async read(rawUrl: string): Promise<WebPage> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Invalid address.');
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicUrl(url, this.lookup);
      const response = await this.fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
      });

      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location');
        if (response.body !== null) await response.body.cancel().catch(() => undefined);
        if (location === null) throw new Error('The page sent a redirect without a target.');
        if (hop === MAX_REDIRECTS) throw new Error('Too many redirects.');
        try {
          url = new URL(location, url);
        } catch {
          throw new Error('The page sent an invalid redirect.');
        }
        continue;
      }

      return this.page(url, response);
    }
    throw new Error('Too many redirects.');
  }

  private async page(url: URL, response: Response): Promise<WebPage> {
    const contentType = response.headers.get('content-type') ?? '';
    const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
    if (!ALLOWED_TYPES.has(mediaType)) throw new Error('지원하지 않는 형식');

    const charset = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim();
    const body = decode(await readCapped(response.body), charset);
    const converted: HtmlText = HTML_TYPES.has(mediaType) ? htmlToText(body) : { text: body };
    return {
      url: url.toString(),
      status: response.status,
      ...(converted.title !== undefined ? { title: converted.title } : {}),
      text: converted.text,
      fetchedAt: this.clock.now(),
    };
  }
}
