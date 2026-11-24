import type { SecretReader } from '../../core/secrets/types.js';
import { parseJsonObject } from './json.js';
import { OAUTH_CLIENT_SECRET, REFRESH_TOKEN_SECRET } from './token.js';

/**
 * More than one Google account (§33). The first account keeps the original secrets; each added one gets a slot with
 * its own refresh token (`google.refresh-token.a2` …). `google.accounts` lists them with their addresses.
 */
export const ACCOUNTS_SECRET = 'google.accounts';
export const EXTRA_SLOTS = ['a2', 'a3', 'a4', 'a5'] as const;
export const MAX_ACCOUNTS = EXTRA_SLOTS.length + 1;

export interface GoogleAccount {
  /** '' for the first account; a slot (a2 …) for an added one. */
  key: string;
  /** Its address, when known ("" for the first account connected before accounts were listed). */
  email: string;
}

export function refreshSecretFor(key: string): string {
  return key === '' ? REFRESH_TOKEN_SECRET : `${REFRESH_TOKEN_SECRET}.${key}`;
}

/** Every secret a Google connector may read: the client, each account's refresh token and the list. */
export const GOOGLE_SECRETS: readonly string[] = [OAUTH_CLIENT_SECRET, REFRESH_TOKEN_SECRET, ACCOUNTS_SECRET, ...EXTRA_SLOTS.map(refreshSecretFor)];

export interface AccountList {
  /** The first account's address, once known. */
  primary: string;
  extra: GoogleAccount[];
}

/** The saved list; a missing or broken one is just the first account. */
export async function readAccountList(secrets: SecretReader): Promise<AccountList> {
  const raw = await secrets.get(ACCOUNTS_SECRET).catch(() => undefined);
  const parsed = raw === undefined ? undefined : parseJsonObject(raw);
  const primary = typeof parsed?.['primary'] === 'string' ? parsed['primary'] : '';
  const extra = Array.isArray(parsed?.['extra'])
    ? (parsed['extra'] as unknown[]).flatMap((item) => {
        const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
        const key = record['key'];
        const email = record['email'];
        return typeof key === 'string' && (EXTRA_SLOTS as readonly string[]).includes(key) && typeof email === 'string' ? [{ key, email }] : [];
      })
    : [];
  return { primary, extra };
}

/** All accounts, the first one first. */
export function accountsOf(list: AccountList): GoogleAccount[] {
  return [{ key: '', email: list.primary }, ...list.extra];
}

/** Ids from an added account carry its slot ("a2~<id>"), so a later read, reply or archive goes to that account. */
export function joinId(key: string, id: string): string {
  return key === '' ? id : `${key}~${id}`;
}

export function splitId(id: string): { key: string; id: string } {
  const match = /^(a[2-5])~(.+)$/.exec(id);
  return match === null ? { key: '', id } : { key: match[1] ?? '', id: match[2] ?? '' };
}

/** How an account is named to the owner. */
export function accountLabel(account: GoogleAccount): string {
  return account.email !== '' ? account.email : account.key === '' ? '기본 계정' : `계정 ${account.key.slice(1)}`;
}
