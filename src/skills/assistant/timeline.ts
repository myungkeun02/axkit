import { z } from 'zod';
import type { ConversationRef } from '../../core/conversation/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import { conversationKey } from '../../core/conversation/thread.js';
import { maskSecrets } from './mask.js';

const KEY = 'timeline';
const MAX_ENTRIES = 40;
const SHOWN = 8;
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const CHARS = 160;

const EntrySchema = z.object({ at: z.string(), where: z.string(), owner: z.string(), assistant: z.string() });
type Entry = z.infer<typeof EntrySchema>;

/** The owner's app chat and Discord DM are one thread, so neither shows the other as "elsewhere". */
function where(ref: ConversationRef): string {
  return conversationKey(ref);
}

function short(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= CHARS ? one : `${one.slice(0, CHARS - 1)}…`;
}

/**
 * One owner across every chat: the last exchanges from all conversations (app, Discord, bot rooms), so a turn here knows
 * what was just said there. Short lines only; each conversation keeps its own full history separately.
 */
export class Timeline {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
  ) {}

  private async entries(): Promise<Entry[]> {
    const parsed = z.array(EntrySchema).safeParse(await this.kv.get<unknown>(KEY));
    return parsed.success ? parsed.data : [];
  }

  async add(ref: ConversationRef, label: string, owner: string, assistant: string): Promise<void> {
    const list = await this.entries();
    list.push({ at: this.clock.now().toISOString(), where: `${where(ref)}|${label}`, owner: maskSecrets(short(owner)), assistant: maskSecrets(short(assistant)) });
    await this.kv.set(KEY, list.slice(-MAX_ENTRIES));
  }

  /** Recent exchanges from other conversations than this one, oldest first; undefined when there are none. */
  async section(ref: ConversationRef, korean: boolean): Promise<string | undefined> {
    const now = this.clock.now().getTime();
    const here = where(ref);
    const others = (await this.entries()).filter((entry) => !entry.where.startsWith(`${here}|`) && now - Date.parse(entry.at) <= WINDOW_MS).slice(-SHOWN);
    if (others.length === 0) return undefined;
    const head = korean ? '## 다른 대화창에서 최근에 나눈 이야기 (데이터; 이어지는 이야기면 자연스럽게 이어 가요)' : '## Recently in the owner’s other chats (data; continue naturally when this connects)';
    return [head, ...others.map((entry) => `- ${entry.at.slice(5, 16).replace('T', ' ')} [${entry.where.split('|')[1] ?? ''}] ${korean ? '오너' : 'owner'}: ${entry.owner} / ${korean ? '비서' : 'you'}: ${entry.assistant}`)].join('\n');
  }
}
