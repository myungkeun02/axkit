import type { MailAttachment, MailAttachmentReader } from '../../core/contracts/mail.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GoogleAttachmentsOptions {
  request: GoogleRequestFn;
}

interface PayloadPart {
  mimeType?: unknown;
  filename?: unknown;
  body?: unknown;
  parts?: unknown;
}

function walk(part: PayloadPart, out: MailAttachment[]): void {
  const body = isRecord(part.body) ? part.body : undefined;
  const filename = typeof part.filename === 'string' ? part.filename.trim() : '';
  const attachmentId = typeof body?.attachmentId === 'string' ? body.attachmentId : '';
  if (filename !== '' && attachmentId !== '') {
    out.push({
      id: attachmentId,
      filename,
      mimeType:
        typeof part.mimeType === 'string' && part.mimeType !== '' ? part.mimeType : 'application/octet-stream',
      size: typeof body?.size === 'number' && Number.isFinite(body.size) ? body.size : 0,
    });
  }
  if (!Array.isArray(part.parts)) return;
  for (const child of part.parts) {
    if (isRecord(child)) walk(child, out);
  }
}

/** Gmail attachment adapter. Lists payload parts recursively and downloads one attachment at a time. */
export class GmailAttachments implements MailAttachmentReader {
  constructor(private readonly deps: GoogleAttachmentsOptions) {}

  async list(messageId: string): Promise<MailAttachment[]> {
    const message = await this.deps.request<{ payload?: unknown }>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`,
    );
    if (!isRecord(message) || !isRecord(message.payload)) return [];
    const out: MailAttachment[] = [];
    walk(message.payload, out);
    return out;
  }

  async download(messageId: string, attachmentId: string, maxBytes: number): Promise<Uint8Array> {
    const listed = await this.list(messageId);
    const known = listed.find((attachment) => attachment.id === attachmentId);
    if (known !== undefined && known.size > maxBytes) {
      throw new Error(`Gmail attachment ${attachmentId} is larger than ${maxBytes} bytes.`);
    }

    const response = await this.deps.request<{ data?: unknown }>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    const data = isRecord(response) && typeof response.data === 'string' ? response.data : '';
    if (data === '') throw new Error(`Gmail returned no data for attachment ${attachmentId}.`);

    const bytes = new Uint8Array(Buffer.from(data, 'base64url'));
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Gmail attachment ${attachmentId} is larger than ${maxBytes} bytes.`);
    }
    return bytes;
  }
}
