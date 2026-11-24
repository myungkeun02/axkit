import type { CompanyConfig, CompanyLimits, CompanyTask } from './types.js';

export type IntakeVerdict = { ok: true } | { ok: false; reason: 'company_full' | 'team_full' | 'unknown_team' };

/** Awaiting-accept work counts too: what is not finished occupies a slot. */
export function checkIntake(
  open: readonly CompanyTask[],
  team: string | undefined,
  config: CompanyConfig,
): IntakeVerdict {
  if (team !== undefined && !config.teams.some((candidate) => candidate.id === team)) {
    return { ok: false, reason: 'unknown_team' };
  }
  if (open.length >= config.limits.maxOpen) return { ok: false, reason: 'company_full' };
  if (team !== undefined) {
    const inTeam = open.filter((task) => task.team === team).length;
    if (inTeam >= config.limits.maxOpenPerTeam) return { ok: false, reason: 'team_full' };
  }
  return { ok: true };
}

/** Self-tuning may only tighten a limit, never loosen what the config set. */
export function effectiveLimits(config: CompanyConfig, overrides: Partial<CompanyLimits>): CompanyLimits {
  const pick = (key: keyof CompanyLimits): number => {
    const base = config.limits[key];
    const override = overrides[key];
    return override === undefined || !Number.isFinite(override) ? base : Math.min(base, override);
  };
  return {
    maxOpen: pick('maxOpen'),
    maxOpenPerTeam: pick('maxOpenPerTeam'),
    maxAgeHours: pick('maxAgeHours'),
    ownerWaitDays: pick('ownerWaitDays'),
    maxRevisions: pick('maxRevisions'),
    maxSteps: pick('maxSteps'),
  };
}
