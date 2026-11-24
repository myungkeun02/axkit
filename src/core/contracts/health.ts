/**
 * Standing checks for the problem types the original assistant ran into: knowledge out of step with reality,
 * switches left on, backlog, too many notices, and operational risks such as running uncommitted code.
 */
export type HealthArea = 'knowledge' | 'switch' | 'backlog' | 'notice' | 'ops' | 'model';

export interface HealthFinding {
  /** Stable id: "switch.long-paused:mail", "backlog.stale". */
  id: string;
  area: HealthArea;
  ok: boolean;
  /** One line for doctor and the weekly report. */
  line: string;
  /** What to do, one line. */
  fix?: string;
}

export interface HealthCheck {
  id: string;
  run(now: Date): Promise<readonly HealthFinding[]>;
}

/** Capability "core.health". Plugins register checks in setup; doctor and the weekly report run them. */
export interface HealthRegistry {
  register(check: HealthCheck): void;
  /** A check that throws becomes one failed finding; it never stops the others. */
  runAll(now: Date): Promise<HealthFinding[]>;
}
