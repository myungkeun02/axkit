import type { KoLifeDeps } from '../../../src/connectors/ko-life/deps.js';
import { koLifeTexts } from '../../../src/connectors/ko-life/locale.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

export interface Call {
  url: URL;
  init: RequestInit | undefined;
}

export type Route = (url: URL, init: RequestInit | undefined) => unknown;

export function fakeFetch(handler: Route): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    calls.push({ url, init });
    const body = await handler(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

export function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

export interface DepsOptions {
  secrets?: Record<string, string>;
  clock?: FakeClock;
  kv?: MapKeyValueStore;
}

export function makeDeps(fetchImpl: typeof fetch, opts: DepsOptions = {}): KoLifeDeps {
  return {
    fetch: fetchImpl,
    secrets: new MemorySecretStore(opts.secrets ?? {}),
    clock: opts.clock ?? new FakeClock(NOW),
    kv: opts.kv ?? new MapKeyValueStore(),
    texts: koLifeTexts('ko'),
  };
}

export function envelope(items: unknown[]): unknown {
  return { response: { header: { resultCode: '00' }, body: { items: { item: items } } } };
}
