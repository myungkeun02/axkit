import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PAIRING_SCRIPT } from './pairing-html.js';

const SCRIPT_HASH = createHash('sha256').update(PAIRING_SCRIPT).digest('base64');
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; " +
  `script-src 'sha256-${SCRIPT_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', CSP);
}

export function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export function sendHtml(response: ServerResponse, status: number, html: string): void {
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

/** Reads at most `cap` bytes; undefined means the body was larger (the rest is drained, not kept). */
export async function readBody(request: IncomingMessage, cap: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size <= cap) chunks.push(buffer);
  }
  return size > cap ? undefined : Buffer.concat(chunks);
}

export async function readJson(request: IncomingMessage, cap: number): Promise<{ value: unknown } | 'too_large' | 'bad_json'> {
  const body = await readBody(request, cap);
  if (body === undefined) return 'too_large';
  try {
    return { value: JSON.parse(body.toString('utf8') || '{}') as unknown };
  } catch {
    return 'bad_json';
  }
}
