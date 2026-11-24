export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPayload {
  mimeType?: string;
  /** Set on attachment parts. */
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailPayload[];
}

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface ReplyMimeInput {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  inReplyTo?: string;
  references?: readonly string[];
  body: string;
  attachments?: readonly MimeAttachment[];
}

const FOLD_AT = 76;
const NON_ASCII = /[^ -~]/;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Base64url-encodes UTF-8 text (Gmail raw format). */
export function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decodes a Gmail base64url body into UTF-8 text. */
export function decodeBase64Url(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/** Removes CR/LF so a value cannot start a new header. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value: string): string {
  const clean = headerValue(value);
  return NON_ASCII.test(clean) ? `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=` : clean;
}

function addressList(values: readonly string[]): string {
  return values.map(headerValue).filter((value) => value !== '').join(', ');
}

/** Adds "Re: " unless the subject already carries a reply prefix. */
export function replySubject(subject: string): string {
  const clean = headerValue(subject);
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** Builds a UTF-8 plain-text reply message ready for Gmail's `raw` field. */
export function buildReplyMime(input: ReplyMimeInput): string {
  const lines: string[] = [];
  const to = addressList(input.to);
  if (to !== '') lines.push(`To: ${to}`);
  const cc = input.cc === undefined ? '' : addressList(input.cc);
  if (cc !== '') lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${encodeHeader(replySubject(input.subject))}`);

  const inReplyTo = input.inReplyTo === undefined ? '' : headerValue(input.inReplyTo);
  if (inReplyTo !== '') lines.push(`In-Reply-To: ${inReplyTo}`);
  if (input.references !== undefined) {
    const references = input.references.map(headerValue).filter((value) => value !== '');
    if (references.length > 0) lines.push(`References: ${references.join(' ')}`);
  }

  lines.push('MIME-Version: 1.0');
  return withBody(lines, input.body, input.attachments ?? []);
}

function folded(data: Uint8Array): string {
  return Buffer.from(data).toString('base64').match(new RegExp(`.{1,${FOLD_AT}}`, 'g'))?.join('\r\n') ?? '';
}

/** RFC 2231 file name, so Korean names survive every mail client. */
function filenameParams(name: string): string {
  const clean = headerValue(name).replace(/["\\]/g, '_');
  if (!NON_ASCII.test(clean)) return `filename="${clean}"`;
  return `filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** Plain text alone, or multipart/mixed with the files after the text. */
function withBody(headers: string[], text: string, attachments: readonly MimeAttachment[]): string {
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${folded(Buffer.from(text, 'utf8'))}\r\n`;
  }
  const boundary = `axkit-${Buffer.from(String(Date.now()) + String(Math.random())).toString('hex').slice(0, 24)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${folded(Buffer.from(text, 'utf8'))}`,
    ...attachments.map(
      (file) =>
        `--${boundary}\r\nContent-Type: ${headerValue(file.mimeType)}; name="${headerValue(file.filename).replace(/["\\]/g, '_')}"\r\n` +
        `Content-Disposition: attachment; ${filenameParams(file.filename)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${folded(file.data)}`,
    ),
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--\r\n`;
}

export interface NewMimeInput {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  body: string;
}

function assertHeaderSafe(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('header value contains CR or LF');
  return value;
}

/** Builds a UTF-8 plain-text new message for Gmail's `raw` field. Throws when a header could be injected. */
export function buildNewMime(input: NewMimeInput): string {
  const to = addressList(input.to.map(assertHeaderSafe));
  const cc = (input.cc ?? []).map(assertHeaderSafe);
  const lines: string[] = [];
  if (to !== '') lines.push(`To: ${to}`);
  if (cc.length > 0) lines.push(`Cc: ${addressList(cc)}`);
  lines.push(
    `Subject: ${encodeHeader(assertHeaderSafe(input.subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  );

  const encoded = Buffer.from(input.body, 'utf8').toString('base64');
  const body = encoded.match(new RegExp(`.{1,${FOLD_AT}}`, 'g'))?.join('\r\n') ?? '';
  return `${lines.join('\r\n')}\r\n\r\n${body}\r\n`;
}

function findBody(part: GmailPayload, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && typeof part.body?.data === 'string' && part.body.data !== '') {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match] ?? match)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Prefers a text/plain part; falls back to text/html with tags stripped. */
export function extractPlainText(payload: GmailPayload): string {
  const plain = findBody(payload, 'text/plain');
  if (plain !== undefined) return plain;
  const html = findBody(payload, 'text/html');
  return html === undefined ? '' : stripHtml(html);
}

/** File names of the attachment parts, in order. */
export function attachmentNames(payload: GmailPayload): string[] {
  const out: string[] = [];
  const walk = (part: GmailPayload): void => {
    if (typeof part.filename === 'string' && part.filename !== '') out.push(part.filename);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}
