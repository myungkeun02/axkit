import { botOfAddress } from '../../core/contracts/bots.js';
import type { EventBus, Unsubscribe } from '../../core/events/types.js';
import type { Clock } from '../../core/scheduler/types.js';

/** §4 `activity`: not in the log (no seq); sent live on the stream, and the current state once on connect. */
export interface ActivityEvent {
  type: 'activity';
  /** The room it is in; absent means the main chat. */
  channel?: string;
  state: 'thinking' | 'working' | 'idle';
  /** What it is doing, in the owner's words ("메일 보는 중"). Only while working. */
  step?: string;
  at: string;
}

type Listener = (event: ActivityEvent) => void;

/** A turn that never says idle (a crash) stops showing after this long. */
const STALE_MS = 3 * 60_000;

const KO_STEPS: readonly [RegExp, string][] = [
  [/^mail\./, '메일 보는 중'],
  [/^calendar\./, '일정 보는 중'],
  [/^todo\./, '할 일 정리하는 중'],
  [/^(docs|sheets)\./, '문서 보는 중'],
  [/^contacts\./, '주소록 찾는 중'],
  [/^files\./, '파일 찾는 중'],
  [/^(web|browser|ways)\./, '웹에서 찾아보는 중'],
  [/^(memory|people)\./, '기억 찾아보는 중'],
  [/^(bots|company)\./, '팀에 맡기는 중'],
  [/^routines\./, '루틴 정리하는 중'],
  [/^(life|places|routes|weather|transit)\./, '찾아보는 중'],
];
const EN_STEPS: readonly [RegExp, string][] = [
  [/^mail\./, 'Checking mail'],
  [/^calendar\./, 'Checking the calendar'],
  [/^todo\./, 'Sorting to-dos'],
  [/^(docs|sheets)\./, 'Reading documents'],
  [/^contacts\./, 'Looking up contacts'],
  [/^files\./, 'Looking for files'],
  [/^(web|browser|ways)\./, 'Looking it up on the web'],
  [/^(memory|people)\./, 'Remembering'],
  [/^(bots|company)\./, 'Handing it to the team'],
  [/^routines\./, 'Sorting routines'],
];

/** A tool name in plain words; an unknown tool is just "working on it". */
export function stepLabel(tool: string, korean: boolean): string {
  const table = korean ? KO_STEPS : EN_STEPS;
  return table.find(([pattern]) => pattern.test(tool))?.[1] ?? (korean ? '작업하는 중' : 'Working on it');
}

/**
 * Whether the assistant is busy in each app room: the "생각하는 중…" hint under the chat. Only app conversations;
 * tool names never leave the server, only the plain step label.
 */
export class AppActivity {
  private readonly current = new Map<string, ActivityEvent & { since: number }>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly channelId: string,
    private readonly clock: Clock,
    private readonly korean: boolean,
  ) {}

  attach(bus: EventBus): Unsubscribe {
    return bus.on('assistant.activity', (payload) => {
      if (payload.conversation.channelId !== this.channelId) return;
      const room = botOfAddress(payload.conversation.address);
      this.set(room, payload.state, payload.tool);
    });
  }

  /** Busy rooms right now, for a client that just connected. */
  snapshot(): ActivityEvent[] {
    const now = this.clock.now().getTime();
    const out: ActivityEvent[] = [];
    for (const [key, event] of this.current) {
      if (now - event.since > STALE_MS) this.current.delete(key);
      else out.push(strip(event));
    }
    return out;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(room: string | undefined, state: ActivityEvent['state'], tool: string | undefined): void {
    const key = room ?? '';
    const now = this.clock.now();
    const event: ActivityEvent = {
      type: 'activity',
      ...(room !== undefined ? { channel: room } : {}),
      state,
      ...(state === 'working' && tool !== undefined ? { step: stepLabel(tool, this.korean) } : {}),
      at: now.toISOString(),
    };
    if (state === 'idle') this.current.delete(key);
    else this.current.set(key, { ...event, since: now.getTime() });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // one broken stream never stops the others
      }
    }
  }
}

function strip(event: ActivityEvent & { since: number }): ActivityEvent {
  return {
    type: 'activity',
    ...(event.channel !== undefined ? { channel: event.channel } : {}),
    state: event.state,
    ...(event.step !== undefined ? { step: event.step } : {}),
    at: event.at,
  };
}
