import { createHash } from 'node:crypto';
import type { TuningChange } from '../../core/contracts/index.js';

/** Domain, subject, action and value: the identity of an approved adjustment. */
export function changeKey(change: TuningChange): string {
  return [change.domain, change.subject, change.action, change.value ?? ''].join('\u0000');
}

export function changeId(change: TuningChange): string {
  return createHash('sha256').update(changeKey(change)).digest('hex').slice(0, 8);
}

export function sameChange(left: TuningChange, right: TuningChange): boolean {
  return changeKey(left) === changeKey(right);
}

export function withId(change: Omit<TuningChange, 'id'>): TuningChange {
  return { id: changeId({ id: '', ...change }), ...change };
}

/** Undo of `set` removes the rule at the domain owner; undo of `mute` turns the subject back on. */
export function inverseChange(change: TuningChange): TuningChange {
  if (change.action === 'mute') {
    return withId({ domain: change.domain, subject: change.subject, action: 'unmute' });
  }
  if (change.action === 'unmute') {
    return withId({ domain: change.domain, subject: change.subject, action: 'mute' });
  }
  return withId({ domain: change.domain, subject: change.subject, action: 'unmute' });
}
