import type { SecretStore } from '../core/secrets/types.js';
import { discordPairing } from '../channels/discord/index.js';
import { connectGoogle } from '../connectors/google/connect.js';
import type { ConnectGoogleResult } from '../connectors/google/connect.js';

export interface PairOwnerOnDiscordOptions {
  token: string;
  /** The 6 digits shown in the terminal. */
  code: string;
  language: string;
  expiresMs?: number;
}

export interface PairOwnerOnDiscordResult {
  userId: string;
}

/** Waits for the owner to DM the pairing code, using a real Discord connection. */
export async function pairOwnerOnDiscord(opts: PairOwnerOnDiscordOptions): Promise<PairOwnerOnDiscordResult> {
  const port = discordPairing.createPort();
  return await discordPairing.waitForOwnerPairing({
    port,
    token: opts.token,
    code: opts.code,
    language: opts.language,
    ...(opts.expiresMs !== undefined ? { expiresMs: opts.expiresMs } : {}),
  });
}

/** A fresh 6-digit pairing code. */
export function newPairingCode(): string {
  return discordPairing.newPairingCode();
}

export interface ConnectGoogleAccountOptions {
  secrets: SecretStore;
  clientJson: string;
  openUrl: (url: string) => Promise<void>;
}

/** Runs the Google desktop OAuth flow; the browser is opened by the caller's `openUrl`. */
export async function connectGoogleAccount(opts: ConnectGoogleAccountOptions): Promise<ConnectGoogleResult> {
  return await connectGoogle(opts);
}
