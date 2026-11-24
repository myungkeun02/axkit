import type { OneTimeCode, OneTimeCodeVault } from '../core/contracts/index.js';
import type { Clock } from '../core/scheduler/types.js';
import { extractOneTimeCode } from './locale-ko-rules.js';

interface StoredCode {
  code: string;
  source?: string;
  at: string;
}

const TTL_MS = 10 * 60_000;
const MAX_CODES = 20;

/** One-time codes live in this process only: never kv, never a notice, never a log line. */
export class OtpVault implements OneTimeCodeVault {
  private codes: StoredCode[] = [];

  constructor(private readonly clock: Clock) {}

  /** Returns true when the text carried a code. The caller must not log the text. */
  record(source: string | undefined, text: string, at: Date): boolean {
    const code = extractOneTimeCode(text);
    if (code === undefined) return false;
    this.prune(at.getTime());
    this.codes.push({
      code,
      ...(source !== undefined && source !== '' ? { source: source.slice(0, 40) } : {}),
      at: at.toISOString(),
    });
    this.codes = this.codes.slice(-MAX_CODES);
    return true;
  }

  latest(maxAgeMinutes = 10): OneTimeCode | undefined {
    const now = this.clock.now().getTime();
    const maxAge = Math.max(0, Math.min(maxAgeMinutes, 10)) * 60_000;
    this.prune(now);
    for (let index = this.codes.length - 1; index >= 0; index -= 1) {
      const entry = this.codes[index];
      if (entry === undefined) continue;
      if (now - Date.parse(entry.at) > maxAge) continue;
      return {
        code: entry.code,
        at: new Date(entry.at),
        ...(entry.source !== undefined ? { source: entry.source } : {}),
      };
    }
    return undefined;
  }

  private prune(now: number): void {
    this.codes = this.codes.filter((entry) => now - Date.parse(entry.at) <= TTL_MS);
  }
}
