import type { PluginContext } from '../../core/plugin/types.js';
import { accountLabel, accountsOf, readAccountList, refreshSecretFor } from './accounts.js';
import type { GoogleAccount } from './accounts.js';
import { googleRequest } from './http.js';
import type { GoogleRequestFn } from './http.js';
import { GoogleTokenSource } from './token.js';

export interface GoogleRequestOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface AccountService<T> {
  account: GoogleAccount;
  /** How the owner knows the account (its address), for results from more than one. */
  label: string;
  service: T;
}

/** The list is read again after this long, so an account added with `ax-kit connect google add` shows up. */
const LIST_TTL_MS = 60_000;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Requests signed with one account's token. */
export function accountRequest(ctx: PluginContext, opts: GoogleRequestOptions, key: string): { request: GoogleRequestFn; tokens: GoogleTokenSource; fetch: typeof fetch; sleep: (ms: number) => Promise<void> } {
  const fetchImpl = opts.fetch ?? fetch;
  const tokens = new GoogleTokenSource({ secrets: ctx.secrets, clock: ctx.clock, fetch: fetchImpl, refreshSecret: refreshSecretFor(key) });
  const sleep = opts.sleep ?? defaultSleep;
  return { request: <T>(url: string, init?: RequestInit): Promise<T> => googleRequest<T>({ fetch: fetchImpl, tokens, sleep }, url, init), tokens, fetch: fetchImpl, sleep };
}

/**
 * One service per connected Google account (the first one first), made once per account and kept; `primary` is the
 * first account's, which every write goes through.
 */
export function accountServices<T>(ctx: PluginContext, make: (key: string) => T, primary: T): () => Promise<AccountService<T>[]> {
  const made = new Map<string, T>([['', primary]]);
  let cached: { at: number; list: AccountService<T>[] } | undefined;
  return async () => {
    const now = ctx.clock.now().getTime();
    if (cached !== undefined && now - cached.at < LIST_TTL_MS) return cached.list;
    const accounts = accountsOf(await readAccountList(ctx.secrets));
    const list = accounts.map((account) => {
      let service = made.get(account.key);
      if (service === undefined) {
        service = make(account.key);
        made.set(account.key, service);
      }
      return { account, label: accountLabel(account), service };
    });
    cached = { at: now, list };
    return list;
  };
}

/** Every account's answer; the ones that failed are left out unless all did (then the first error is thrown). */
export async function fromAll<T, R>(accounts: readonly AccountService<T>[], ask: (item: AccountService<T>) => Promise<R>): Promise<{ item: AccountService<T>; value: R }[]> {
  const settled = await Promise.allSettled(accounts.map(async (item) => ({ item, value: await ask(item) })));
  const ok = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failed = settled.find((result) => result.status === 'rejected');
  if (ok.length === 0 && failed !== undefined) throw failed.reason;
  return ok;
}
