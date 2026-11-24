import type { ConfirmPolicyConfig, Effect } from './types.js';
import { ALWAYS_CONFIRM } from './types.js';

export const DEFAULT_CONFIRM_POLICY: ConfirmPolicyConfig = { confirmWrites: false, expiresMinutes: 30 };

export function needsConfirmation(effects: readonly Effect[], cfg: ConfirmPolicyConfig): boolean {
  return effects.some((effect) => {
    if (ALWAYS_CONFIRM.includes(effect)) return true;
    return effect === 'write' && cfg.confirmWrites;
  });
}
