import { createHash, randomBytes } from 'node:crypto';
import { isRecord } from './json.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
] as const;

/**
 * Requested only when the owner opts in during setup: adding it to GOOGLE_SCOPES would make existing
 * connections report a missing scope and look broken.
 */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** Lets ax-kit save the documents it makes (meeting notes); it sees only files it created itself. */
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/**
 * Opt-in like Drive: lets ax-kit archive mail and add or remove labels ("Gmail 정리"). It would also allow trashing,
 * which the organizer never does: it only changes INBOX, a few system labels and the owner's own labels.
 */
export const GOOGLE_GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface AuthUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: readonly string[];
}

/** Reads the downloaded "Desktop app" OAuth client file. */
export function parseClientJson(text: string): GoogleClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'The Google client file is not valid JSON. Download the "Desktop app" client JSON again from Google Cloud Console.',
    );
  }
  if (!isRecord(parsed)) {
    throw new Error('The Google client file does not contain an OAuth client. Download the "Desktop app" client JSON again.');
  }
  if (isRecord(parsed.web)) {
    throw new Error(
      'This is a "Web application" OAuth client. Create a "Desktop app" client in Google Cloud Console and download its JSON instead.',
    );
  }
  const installed = parsed.installed;
  if (!isRecord(installed)) {
    throw new Error('The Google client file has no "installed" section. Create a "Desktop app" OAuth client and download its JSON.');
  }
  const clientId = installed.client_id;
  const clientSecret = installed.client_secret;
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    throw new Error('The Google client file is missing client_id or client_secret. Download the "Desktop app" client JSON again.');
  }
  return { clientId, clientSecret };
}

/** Creates a PKCE verifier and its S256 challenge. */
export function pkcePair(random: (size: number) => Uint8Array = (size) => randomBytes(size)): PkcePair {
  const verifier = Buffer.from(random(32)).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Builds the Google consent URL. */
export function buildAuthUrl(opts: AuthUrlOptions): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  // the account chooser too, so a second account can be picked while the first is signed in
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
