import type {
  MailAttachment,
  MailAttachmentReader,
  MailMessage,
  MailQuery,
  MailReader,
  MailSummary,
  Notice,
  NoticeResult,
  Notifier,
  RecognizedText,
  SpendEntry,
  SpendReader,
  TextRecognizer,
} from '../../../src/core/contracts/index.js';
import type { Logger } from '../../../src/core/log/types.js';
import type { DocEntry } from '../../../src/skills/receipts/types.js';
import type { VaultFs } from '../../../src/skills/receipts/vault.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');
export const MONTH_END = new Date('2026-11-30T20:30:00+09:00');

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

export class FakeMailReader implements MailReader {
  readonly queries: MailQuery[] = [];
  readonly readIds: string[] = [];

  constructor(
    public summaries: MailSummary[] = [],
    public messages: Record<string, MailMessage> = {},
  ) {}

  async search(query: MailQuery): Promise<MailSummary[]> {
    this.queries.push(query);
    return this.summaries;
  }

  async read(id: string): Promise<MailMessage> {
    this.readIds.push(id);
    const message = this.messages[id];
    if (message === undefined) throw new Error(`no message ${id}`);
    return message;
  }
}

export interface DownloadCall {
  messageId: string;
  attachmentId: string;
  maxBytes: number;
}

export class FakeMailAttachments implements MailAttachmentReader {
  readonly listCalls: string[] = [];
  readonly downloadCalls: DownloadCall[] = [];

  constructor(
    public listed: MailAttachment[] = [],
    public data: Record<string, Uint8Array> = {},
  ) {}

  async list(messageId: string): Promise<MailAttachment[]> {
    this.listCalls.push(messageId);
    return this.listed;
  }

  async download(messageId: string, attachmentId: string, maxBytes: number): Promise<Uint8Array> {
    this.downloadCalls.push({ messageId, attachmentId, maxBytes });
    const data = this.data[attachmentId];
    if (data === undefined) throw new Error('no attachment data');
    return data;
  }
}

export class FakeSpend implements SpendReader {
  readonly ranges: { from: Date; to: Date }[] = [];

  constructor(
    public list: SpendEntry[] = [],
    public home = 'KRW',
    private readonly fail = false,
  ) {}

  async entries(range: { from: Date; to: Date }): Promise<SpendEntry[]> {
    this.ranges.push(range);
    if (this.fail) throw new Error('spending unavailable');
    return this.list.filter((entry) => {
      const at = Date.parse(entry.at);
      return at >= range.from.getTime() && at < range.to.getTime();
    });
  }

  homeCurrency(): string {
    return this.home;
  }
}

export interface FsCall {
  op: 'mkdir' | 'writeFile' | 'chmod';
  path: string;
  mode: number;
}

export class FakeVaultFs implements VaultFs {
  readonly calls: FsCall[] = [];
  readonly files = new Map<string, string | Uint8Array>();
  readonly symlinks = new Map<string, string>();

  addFile(path: string, data: string | Uint8Array = ''): this {
    this.files.set(path, data);
    return this;
  }

  addSymlink(path: string, target: string): this {
    this.symlinks.set(path, target);
    return this;
  }

  async mkdir(path: string, mode: number): Promise<void> {
    this.calls.push({ op: 'mkdir', path, mode });
  }

  async writeFile(path: string, data: string | Uint8Array, mode: number): Promise<void> {
    this.calls.push({ op: 'writeFile', path, mode });
    this.files.set(path, data);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.calls.push({ op: 'chmod', path, mode });
  }

  async realpath(path: string): Promise<string> {
    const seen = new Set<string>();
    let current = path;
    for (;;) {
      const target = this.symlinks.get(current);
      if (target === undefined) break;
      if (seen.has(current)) throw new Error('too many symlinks');
      seen.add(current);
      current = target;
    }
    if (this.exists(current)) return current;
    throw new Error(`ENOENT: ${current}`);
  }

  private exists(path: string): boolean {
    if (this.files.has(path)) return true;
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }
}

export class FakeOcr implements TextRecognizer {
  readonly paths: string[] = [];

  constructor(
    public result: RecognizedText | Error = { text: '', pages: 1, method: 'vision' },
  ) {}

  async recognize(path: string): Promise<RecognizedText> {
    this.paths.push(path);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const noop = (): void => undefined;

export interface CaptureLogger extends Logger {
  readonly warnings: string[];
}

export function captureLogger(): CaptureLogger {
  const warnings: string[] = [];
  const logger: CaptureLogger = {
    warnings,
    debug: noop,
    info: noop,
    error: noop,
    warn: (message) => {
      warnings.push(message);
    },
    child: () => logger,
  };
  return logger;
}

export function summary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'mail-1',
    threadId: 'thread-1',
    from: '카페 예시 <billing@example.com>',
    subject: '영수증 안내',
    snippet: '',
    receivedAt: new Date('2026-11-17T10:00:00+09:00'),
    unread: true,
    important: false,
    ...overrides,
  };
}

export function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    ...summary(),
    to: ['owner@example.com'],
    cc: [],
    body: '결제 완료\n합계 12,345원',
    ...overrides,
  };
}

export function attachment(overrides: Partial<MailAttachment> = {}): MailAttachment {
  return { id: 'att-1', filename: 'receipt.pdf', mimeType: 'application/pdf', size: 100, ...overrides };
}

export function spendEntry(overrides: Partial<SpendEntry> = {}): SpendEntry {
  return {
    id: 'spend-1',
    at: '2026-11-03T12:00:00+09:00',
    merchant: '카페 예시',
    merchantKey: '카페예시',
    amount: 50_000,
    currency: 'KRW',
    originalAmount: 50_000,
    source: 'sms',
    category: 'food',
    categorySource: 'rule',
    ...overrides,
  };
}

export function docEntry(overrides: Partial<DocEntry> = {}): DocEntry {
  return {
    id: 'doc-1',
    mailId: 'mail-1',
    kind: 'receipt',
    subject: '영수증 안내',
    from: '카페 예시 <billing@example.com>',
    at: '2026-11-03T12:00:00+09:00',
    amount: 50_000,
    currency: 'KRW',
    merchant: '카페 예시',
    merchantKey: '카페예시',
    files: ['2026-11/2026-11-03-receipt-영수증 안내-mail-1/mail.txt'],
    ...overrides,
  };
}
