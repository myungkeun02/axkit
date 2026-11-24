import { googleRequest } from '../../../src/connectors/google/http.js';
import type { GoogleRequestFn } from '../../../src/connectors/google/http.js';

export interface FetchCall {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FetchCall[];
}

function bodyText(body: RequestInit['body']): string | undefined {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

export function fakeFetch(handler: FetchHandler): FakeFetch {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = {
      url: new URL(target),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: bodyText(init?.body),
    };
    calls.push(call);
    return await handler(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A request function with a fixed bearer token, for adapter tests. */
export function requestWithToken(fake: FakeFetch, token = 'token-1'): GoogleRequestFn {
  const tokens = {
    accessToken: async (): Promise<string> => token,
    invalidate: (): void => undefined,
  };
  return <T>(url: string, init?: RequestInit): Promise<T> =>
    googleRequest<T>({ fetch: fake.fetch, tokens, sleep: async () => undefined }, url, init);
}

export function formBody(call: FetchCall | undefined): URLSearchParams {
  return new URLSearchParams(call?.body ?? '');
}
