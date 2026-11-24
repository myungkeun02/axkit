import { z } from 'zod';
import type { Tool } from '../tools/types.js';
import type { KillState, KillSwitch } from './kill.js';

const stopInput = z.object({ reason: z.string().max(300).default('') });
const resumeInput = z.object({});

/** Stopping is always safe, so it never waits for a card; anyone the assistant listens to may pull it. */
export function stopAllTool(kill: KillSwitch): Tool<z.infer<typeof stopInput>, KillState> {
  return {
    name: 'safety.stop_all',
    description:
      'Stop everything that leaves this Mac (sending, paying, deleting) until the owner resumes. Use at once when the ' +
      'owner says stop, 멈춰, 전부 정지, or seems alarmed about what the assistant is doing.',
    input: stopInput,
    effects: ['write'],
    run: (value) => kill.stop(value.reason, 'owner'),
  };
}

/** Resuming always asks on a card, so text on a page or in a mail can never switch outward actions back on. */
export function resumeAllTool(kill: KillSwitch): Tool<z.infer<typeof resumeInput>, KillState> {
  return {
    name: 'safety.resume_all',
    description: 'Turn sending, paying and deleting back on after a stop. Only when the owner asks for it.',
    input: resumeInput,
    effects: ['write'],
    uncertainty: () => 'Turning outward actions back on',
    describe: () => 'Resume sending, paying and deleting',
    run: () => kill.resume('owner'),
  };
}

export function stopStatusText(state: KillState, language: 'ko' | 'en'): string {
  if (language === 'en') {
    return state.stopped
      ? `Stopped${state.reason !== undefined ? ` (${state.reason})` : ''}: nothing is sent, paid or deleted.`
      : 'Running: outward actions are on.';
  }
  return state.stopped
    ? `전체 정지 중${state.reason !== undefined ? ` (${state.reason})` : ''}: 보내기·결제·삭제를 하지 않아요.`
    : '정상: 외부 행동이 켜져 있어요.';
}
