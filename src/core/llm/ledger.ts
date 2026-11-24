import type { LlmUsage, UsageLedger } from './types.js';

interface LedgerEntry {
  at: Date;
  purpose: string;
  providerId: string;
  model: string;
  usage: LlmUsage;
}

interface FailureEntry {
  at: Date;
  purpose: string;
  providerId: string;
  model: string;
  code: string;
}

export class MemoryUsageLedger implements UsageLedger {
  private readonly entries: LedgerEntry[] = [];
  private readonly failures: FailureEntry[] = [];

  async record(entry: LedgerEntry): Promise<void> {
    this.entries.push({
      at: new Date(entry.at),
      purpose: entry.purpose,
      providerId: entry.providerId,
      model: entry.model,
      usage: { ...entry.usage },
    });
  }

  async recordFailure(entry: FailureEntry): Promise<void> {
    this.failures.push({ ...entry, at: new Date(entry.at) });
  }

  async spentUsd(since: Date): Promise<number> {
    const threshold = since.getTime();
    let total = 0;
    for (const entry of this.entries) {
      if (entry.at.getTime() >= threshold) total += entry.usage.costUsd;
    }
    return total;
  }
}
