import { randomInt, timingSafeEqual } from 'node:crypto';
import type { DiscordInbound, DiscordPort } from './port.js';
import { pairingTexts } from './pairing-locale.js';

const CODE_PATTERN = /^\d{6}$/;
const CODE_RANGE = 1_000_000;
const DEFAULT_EXPIRES_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export interface OwnerPairingOptions {
  port: DiscordPort;
  token: string;
  code: string;
  language: string;
  expiresMs?: number;
  maxAttempts?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Cryptographically random 6-digit code, zero padded. */
export function newPairingCode(random: (min: number, max: number) => number = randomInt): string {
  return String(random(0, CODE_RANGE)).padStart(6, '0');
}

function sameCode(given: string, expected: Buffer): boolean {
  const buffer = Buffer.from(given, 'utf8');
  if (buffer.length !== expected.length) return false;
  return timingSafeEqual(buffer, expected);
}

type Outcome = { ok: true; userId: string } | { ok: false; error: unknown };

/**
 * Waits for the owner to DM the pairing code. Resolves with the author id of that DM; every other
 * DM is answered and ignored, so a stranger guessing the code is limited by `maxAttempts`.
 */
export async function waitForOwnerPairing(opts: OwnerPairingOptions): Promise<{ userId: string }> {
  const texts = pairingTexts(opts.language);
  const expiresMs = opts.expiresMs ?? DEFAULT_EXPIRES_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout));
  const expected = Buffer.from(opts.code, 'utf8');

  return await new Promise<{ userId: string }>((resolve, reject) => {
    let settled = false;
    let attempts = 0;

    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      void (async () => {
        try {
          await opts.port.destroy();
        } catch {
          // The connection may already be gone; the pairing outcome still stands.
        }
        if (outcome.ok) resolve({ userId: outcome.userId });
        else reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
      })();
    };

    const reply = async (channelId: string, content: string): Promise<void> => {
      try {
        await opts.port.send(channelId, { content });
      } catch {
        // A failed reply must not keep the pairing alive or crash the listener.
      }
    };

    const handle = async (inbound: DiscordInbound): Promise<void> => {
      if (settled || inbound.authorIsBot || !inbound.isDm) return;
      const text = inbound.content.trim();
      if (sameCode(text, expected)) {
        await reply(inbound.channelId, texts.paired);
        finish({ ok: true, userId: inbound.authorId });
        return;
      }
      if (!CODE_PATTERN.test(text)) {
        await reply(inbound.channelId, texts.hint);
        return;
      }
      attempts += 1;
      await reply(inbound.channelId, texts.wrongCode);
      if (attempts >= maxAttempts) finish({ ok: false, error: new Error('too many wrong codes') });
    };

    opts.port.onMessage((inbound) => {
      void handle(inbound);
    });
    const timer = setTimer(() => finish({ ok: false, error: new Error('pairing code expired') }), expiresMs);
    void opts.port.login(opts.token).catch((error: unknown) => {
      finish({ ok: false, error });
    });
  });
}
