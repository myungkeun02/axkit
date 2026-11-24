import { systemClock } from '../../core/scheduler/clock.js';
import type { SecretStore } from '../../core/secrets/types.js';
import { ACCOUNTS_SECRET, EXTRA_SLOTS, MAX_ACCOUNTS, accountsOf, readAccountList, refreshSecretFor } from './accounts.js';
import type { AccountList, GoogleAccount } from './accounts.js';
import { parseJsonObject } from './json.js';
import { runLoopbackConsent } from './loopback.js';
import { GOOGLE_DRIVE_SCOPE, GOOGLE_GMAIL_MODIFY_SCOPE, GOOGLE_SCOPES } from './oauth.js';
import type { GoogleClient } from './oauth.js';
import { GoogleTokenSource, OAUTH_CLIENT_SECRET } from './token.js';

const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export interface AccountDeps {
  secrets: SecretStore;
  fetch?: typeof fetch;
}

async function writeList(secrets: SecretStore, list: AccountList): Promise<void> {
  await secrets.set(ACCOUNTS_SECRET, JSON.stringify(list));
}

/** The address of one connected account (Gmail profile); '' when it cannot be told. */
export async function accountEmail(deps: AccountDeps, key: string): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const token = await new GoogleTokenSource({ secrets: deps.secrets, clock: systemClock, fetch: fetchImpl, refreshSecret: refreshSecretFor(key) }).accessToken();
    const response = await fetchImpl(PROFILE_URL, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const email = parseJsonObject(await response.text())?.['emailAddress'];
    return response.ok && typeof email === 'string' ? email : '';
  } catch {
    return '';
  }
}

/** Every account, filling in the first one's address when it was connected before the list existed. */
export async function listAccounts(deps: AccountDeps): Promise<GoogleAccount[]> {
  const list = await readAccountList(deps.secrets);
  if (list.primary === '' && (await deps.secrets.has(refreshSecretFor('')))) {
    const primary = await accountEmail(deps, '');
    if (primary !== '') {
      list.primary = primary;
      await writeList(deps.secrets, list);
    }
  }
  return (await deps.secrets.has(refreshSecretFor(''))) ? accountsOf(list) : [];
}

export interface AddAccountOptions extends AccountDeps {
  openUrl: (url: string) => void | Promise<void>;
  /** The first account has "Gmail 정리": ask the added one for it too. */
  organize: boolean;
}

export type AddAccountResult = { ok: true; account: GoogleAccount; again: boolean } | { ok: false; reason: string };

/**
 * Signs in one more Google account with the client the first one used (mail, calendar, Drive read). Signing in an
 * account that is already connected refreshes it in place.
 */
export async function addGoogleAccount(opts: AddAccountOptions): Promise<AddAccountResult> {
  const rawClient = await opts.secrets.get(OAUTH_CLIENT_SECRET);
  const parsed = rawClient === undefined ? undefined : parseJsonObject(rawClient);
  if (typeof parsed?.['clientId'] !== 'string' || typeof parsed['clientSecret'] !== 'string') {
    return { ok: false, reason: '먼저 첫 구글 계정을 연결해 주세요: ax-kit connect google' };
  }
  const client: GoogleClient = { clientId: parsed['clientId'], clientSecret: parsed['clientSecret'] };
  const accounts = await listAccounts(opts);
  const list = await readAccountList(opts.secrets);
  const scopes = [...GOOGLE_SCOPES, GOOGLE_DRIVE_SCOPE, ...(opts.organize ? [GOOGLE_GMAIL_MODIFY_SCOPE] : [])];
  const { refreshToken } = await runLoopbackConsent({ client, scopes, openUrl: opts.openUrl, fetch: opts.fetch ?? fetch });

  // into a free slot first, so the address can be read with it
  const free = EXTRA_SLOTS.find((slot) => !list.extra.some((account) => account.key === slot));
  const probe = free ?? 'a5';
  const previous = await opts.secrets.get(refreshSecretFor(probe));
  await opts.secrets.set(refreshSecretFor(probe), refreshToken);
  const email = await accountEmail(opts, probe);
  const same = accounts.find((account) => email !== '' && account.email.toLowerCase() === email.toLowerCase());
  if (same !== undefined) {
    // already connected: keep the new sign-in in its own slot
    if (same.key !== probe) {
      await opts.secrets.set(refreshSecretFor(same.key), refreshToken);
      if (previous === undefined) await opts.secrets.delete(refreshSecretFor(probe));
      else await opts.secrets.set(refreshSecretFor(probe), previous);
    }
    return { ok: true, account: same, again: true };
  }
  if (free === undefined) {
    if (previous === undefined) await opts.secrets.delete(refreshSecretFor(probe));
    else await opts.secrets.set(refreshSecretFor(probe), previous);
    return { ok: false, reason: `구글 계정은 ${MAX_ACCOUNTS}개까지 연결할 수 있어요. 하나를 빼고 다시 해 주세요: ax-kit connect google remove <주소>` };
  }
  const account: GoogleAccount = { key: free, email };
  await writeList(opts.secrets, { ...list, extra: [...list.extra, account] });
  return { ok: true, account, again: false };
}

/** Disconnects an added account (the first one stays: it is the one writes go through). */
export async function removeGoogleAccount(deps: AccountDeps, which: string): Promise<{ ok: boolean; reason?: string }> {
  const list = await readAccountList(deps.secrets);
  const wanted = which.trim().toLowerCase();
  if (wanted !== '' && list.primary.toLowerCase() === wanted) return { ok: false, reason: '첫 계정은 뺄 수 없어요. 바꾸려면 ax-kit connect google 을 다시 해 주세요.' };
  const found = list.extra.find((account) => account.email.toLowerCase() === wanted || account.key === wanted);
  if (found === undefined) return { ok: false, reason: '그런 계정이 연결돼 있지 않아요. ax-kit connect google accounts 로 확인해 주세요.' };
  await deps.secrets.delete(refreshSecretFor(found.key));
  await writeList(deps.secrets, { ...list, extra: list.extra.filter((account) => account.key !== found.key) });
  return { ok: true };
}
