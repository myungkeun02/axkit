import type { Lookup } from '../../../src/connectors/web/address.js';
import { WebPageReader } from '../../../src/connectors/web/reader.js';
import { FakeClock } from '../../core/helpers.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

export type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export interface Call {
  url: URL;
  init: RequestInit | undefined;
}

export function fakeFetch(handler: Route): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

export interface FakeLookup extends Lookup {
  calls: string[];
}

export function fakeLookup(answer: string[] | ((host: string) => string[])): FakeLookup {
  const calls: string[] = [];
  const fn = async (host: string): Promise<string[]> => {
    calls.push(host);
    return typeof answer === 'function' ? answer(host) : answer;
  };
  return Object.assign(fn, { calls });
}

export function readerWith(handler: Route, lookup: Lookup = fakeLookup(['93.184.216.34'])): {
  reader: WebPageReader;
  calls: Call[];
  clock: FakeClock;
} {
  const fake = fakeFetch(handler);
  const clock = new FakeClock(NOW);
  return {
    reader: new WebPageReader({ fetch: fake.fetch, lookup, clock }),
    calls: fake.calls,
    clock,
  };
}

export function page(body: string, status = 200, type = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}
