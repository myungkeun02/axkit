import { readFile } from 'node:fs/promises';
import type { FirstLookProgress } from '../core/contracts/first-look.js';
import { localTokenPath } from '../mobile/local-token.js';
import type { FirstLookResult } from '../skills/assistant/first-look.js';

export interface LocalToken {
  baseUrl: string;
  token: string;
}

/** `~/.ax-kit/desktop.token`, written by the running assistant on every start (loopback only). */
export async function readLocalToken(home: string): Promise<LocalToken | undefined> {
  try {
    const parsed = JSON.parse(await readFile(localTokenPath(home), 'utf8')) as Partial<LocalToken>;
    return typeof parsed.baseUrl === 'string' && typeof parsed.token === 'string' ? { baseUrl: parsed.baseUrl, token: parsed.token } : undefined;
  } catch {
    return undefined;
  }
}

/** `GET views/first-look` (docs/APP-PROTOCOL.md §27). */
export interface FirstLookView extends FirstLookProgress {
  result?: FirstLookResult;
}

export interface ActionAnswer {
  ok: boolean;
  data?: Record<string, unknown>;
  /** A sentence for the owner when the server refused the input. */
  message?: string;
}

/** The running assistant's app API, as the desktop app on this Mac uses it. */
export interface LocalApi {
  /** Undefined while the assistant is not up (no token yet, refused, or the view is not registered yet). */
  view(): Promise<FirstLookView | undefined>;
  act(view: string, action: string, body?: Record<string, unknown>): Promise<ActionAnswer>;
}

/** Reads the token on every call, so a server that restarts (and writes a new token) is picked up. */
export function localApi(home: string, http: typeof fetch = fetch): LocalApi {
  const call = async (path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> } | undefined> => {
    const local = await readLocalToken(home);
    if (local === undefined) return undefined;
    try {
      const response = await http(`${local.baseUrl}/m/v1/app/${path}`, {
        ...init,
        headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    } catch {
      return undefined;
    }
  };
  return {
    async view() {
      const got = await call('views/first-look');
      if (got === undefined || got.status !== 200 || got.body['ok'] !== true) return undefined;
      const data = got.body['data'];
      return typeof data === 'object' && data !== null && typeof (data as { status?: unknown }).status === 'string' ? (data as FirstLookView) : undefined;
    },
    async act(view, action, body = {}) {
      const got = await call(`views/${view}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (got === undefined) return { ok: false };
      const data = got.body['data'];
      const message = got.body['message'];
      return {
        ok: got.status === 200 && got.body['ok'] === true,
        ...(typeof data === 'object' && data !== null ? { data: data as Record<string, unknown> } : {}),
        ...(typeof message === 'string' ? { message } : {}),
      };
    },
  };
}
