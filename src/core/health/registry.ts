import type { HealthCheck, HealthFinding, HealthRegistry } from '../contracts/health.js';

export class HealthChecks implements HealthRegistry {
  private readonly checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    if (this.checks.some((existing) => existing.id === check.id)) {
      throw new Error(`Duplicate health check: ${check.id}`);
    }
    this.checks.push(check);
  }

  async runAll(now: Date): Promise<HealthFinding[]> {
    const findings: HealthFinding[] = [];
    for (const check of this.checks) {
      try {
        findings.push(...(await check.run(now)));
      } catch {
        findings.push({ id: `${check.id}.error`, area: 'ops', ok: false, line: `${check.id}: check failed` });
      }
    }
    return findings;
  }
}
