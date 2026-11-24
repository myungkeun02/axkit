import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonPrivate } from './config.js';

/** A Mac (the assistant's) that paired with this one. Only the token's hash is kept. */
export interface PairedClient {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
}

export type RedeemResult = { status: 'ok'; token: string; client: PairedClient } | { status: 'no_code' | 'expired' | 'wrong' | 'full' };

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CLIENTS = 16;

const clientsSchema = z.object({
  clients: z
    .array(z.object({ id: z.string(), name: z.string().max(80), tokenHash: z.string().length(64), createdAt: z.string(), lastSeenAt: z.string().optional() }))
    .max(MAX_CLIENTS),
});
const pendingSchema = z.object({ codeHash: z.string().length(64), expiresAt: z.string(), attempts: z.number().int().min(0) });

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** "abcd-efgh" and "ABCDEFGH" are the same code. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export interface SourceTokenOptions {
  dir: string;
  now?: () => Date;
  random?: (size: number) => Buffer;
}

/**
 * Pairing and tokens for `ax-kit source serve`. `ax-kit source pair` (another process) writes a short code to
 * pairing.json; the server trades it once for a long token and keeps only the token's hash in tokens.json.
 */
export class SourceTokens {
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;

  constructor(private readonly options: SourceTokenOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
  }

  private get clientsFile(): string {
    return join(this.options.dir, 'tokens.json');
  }

  private get pendingFile(): string {
    return join(this.options.dir, 'pairing.json');
  }

  async clients(): Promise<PairedClient[]> {
    const parsed = clientsSchema.safeParse(await readJson(this.clientsFile));
    return parsed.success ? parsed.data.clients.map((client) => ({ ...client })) as PairedClient[] : [];
  }

  private async saveClients(clients: readonly PairedClient[]): Promise<void> {
    await writeJsonPrivate(this.clientsFile, { clients });
  }

  /** A new one-time code, valid for ten minutes; any older code stops working. Shown as "ABCD-EFGH". */
  async startPairing(): Promise<string> {
    const bytes = this.random(CODE_LENGTH);
    let code = '';
    for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[(bytes[index] ?? 0) % CODE_ALPHABET.length];
    await writeJsonPrivate(this.pendingFile, {
      codeHash: sha256(code),
      expiresAt: new Date(this.now().getTime() + PAIRING_TTL_MS).toISOString(),
      attempts: 0,
    });
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  /** Trades a code for a token. Five wrong tries or ten minutes and the code is gone. */
  async redeem(code: string, name: string): Promise<RedeemResult> {
    const pending = pendingSchema.safeParse(await readJson(this.pendingFile));
    if (!pending.success) return { status: 'no_code' };
    if (Date.parse(pending.data.expiresAt) <= this.now().getTime()) {
      await rm(this.pendingFile, { force: true });
      return { status: 'expired' };
    }
    if (!sameHash(sha256(normalizeCode(code)), pending.data.codeHash)) {
      const attempts = pending.data.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) await rm(this.pendingFile, { force: true });
      else await writeJsonPrivate(this.pendingFile, { ...pending.data, attempts });
      return { status: 'wrong' };
    }
    await rm(this.pendingFile, { force: true });
    const clients = await this.clients();
    if (clients.length >= MAX_CLIENTS) return { status: 'full' };
    const token = this.random(32).toString('base64url');
    const client: PairedClient = {
      id: `c_${this.random(6).toString('hex')}`,
      name: name.slice(0, 80),
      tokenHash: sha256(token),
      createdAt: this.now().toISOString(),
    };
    await this.saveClients([...clients, client]);
    return { status: 'ok', token, client };
  }

  async check(token: string): Promise<PairedClient | undefined> {
    const hash = sha256(token);
    return (await this.clients()).find((client) => sameHash(client.tokenHash, hash));
  }

  /** Removes one paired Mac by name or id, or every one with "all". Returns how many went. */
  async revoke(which: string): Promise<number> {
    const clients = await this.clients();
    const kept = which === 'all' ? [] : clients.filter((client) => client.id !== which && client.name !== which);
    await this.saveClients(kept);
    return clients.length - kept.length;
  }
}
