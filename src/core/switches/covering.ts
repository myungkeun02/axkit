import type { PauseState } from '../contracts/switches.js';

/**
 * A pause stops a job when it names the job, a prefix of it ("spending" for "spending.mail"), or the plugin that owns
 * it ("skill.spending"). The scheduler and the app's jobs screen use the same rule, so "off" on screen is off for real.
 */
export function pauseCovering(name: string, pauses: readonly PauseState[]): PauseState | undefined {
  const head = name.split('.')[0] ?? name;
  return pauses.find(
    (pause) =>
      pause.feature === name ||
      name.startsWith(`${pause.feature}.`) ||
      pause.feature === `skill.${head}` ||
      pause.feature === `connector.${head}`,
  );
}
