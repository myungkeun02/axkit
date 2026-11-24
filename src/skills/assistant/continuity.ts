import { Contracts } from '../../core/contracts/index.js';
import type { ConversationRef, IncomingMessage } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { guardText } from '../../core/text/data.js';
import { OpenLoops } from './open-loops.js';
import type { PlanNotes } from './plan.js';
import { Timeline } from './timeline.js';

const FOLLOW_UP_JOB = 'assistant.open-loops';
/** Durable for months, unlike a passing remark. */
const NOTE_HALF_LIFE_DAYS = 120;

/** "김민수 대표님" → "김민수": a title or honorific after a name is not part of it. */
export function bareName(name: string): string {
  return name.trim().replace(/(\s*(대표|이사|팀장|과장|부장|차장|실장|사장|원장|교수|선생|매니저|님|씨))+$/u, '').trim();
}

/** At least half of a field's words (their first two letters, so Korean endings do not matter) appear in what the owner wrote. */
export function fromOwner(value: string, said: string): boolean {
  const words = value.split(/[\s,.·/()]+/).filter((word) => word.length >= 2);
  if (words.length === 0) return value.trim() === '';
  const hits = words.filter((word) => said.includes(word.slice(0, 2)) || said.toLowerCase().includes(word.slice(0, 2).toLowerCase())).length;
  return hits / words.length >= 0.5;
}

function labelOf(ref: ConversationRef, korean: boolean): string {
  if (ref.channelId === 'channel.app') return korean ? '앱' : 'app';
  if (ref.channelId === 'channel.discord') return korean ? '디스코드' : 'Discord';
  return ref.channelId.replace(/^channel\./, '');
}

/**
 * What makes the assistant one continuous person across chats: a shared recent timeline, facts it noted itself, and
 * the undecided things it follows up on exactly once.
 */
export class Continuity {
  readonly loops: OpenLoops;
  private readonly timeline: Timeline;

  constructor(
    private readonly ctx: PluginContext,
    private readonly korean: boolean,
  ) {
    this.loops = new OpenLoops(ctx);
    this.timeline = new Timeline(ctx.kv, ctx.clock);
  }

  /** Hourly: undecided items left alone for a day are asked about, one card at a time. */
  schedule(): void {
    // cards shown before a restart were lost with their waiters: those items go back to open
    void this.loops.reconcile().catch(() => undefined);
    this.ctx.scheduler.add({
      name: FOLLOW_UP_JOB,
      label: this.korean ? '정하지 않은 일 한 번 챙기기' : 'Follow up undecided items once',
      schedule: { kind: 'every', seconds: 3600 },
      run: async () => {
        await this.loops.followUp(this.korean);
      },
    });
  }

  async sections(message: IncomingMessage): Promise<string[]> {
    const out: string[] = [];
    const recent = await this.timeline.section(message.conversation, this.korean).catch(() => undefined);
    if (recent !== undefined) out.push(recent);
    const open = await this.loops.section(this.korean).catch(() => undefined);
    if (open !== undefined) out.push(open);
    return out;
  }

  async notes(message: IncomingMessage, notes: PlanNotes): Promise<void> {
    const memory = this.ctx.tryUse(Contracts.memoryWrite);
    if (memory !== undefined) {
      for (const text of notes.remember.slice(0, 3)) {
        const trimmed = text.trim();
        if (trimmed.length < 4) continue;
        await memory.remember({ subject: 'owner', text: trimmed.slice(0, 300), source: { kind: 'chat', ref: message.id }, halfLifeDays: NOTE_HALF_LIFE_DAYS });
      }
    }
    await this.people(message, notes);
    await this.loops.resolve(notes.resolved);
    await this.loops.add(message.conversation, notes.open);
  }

  /**
   * Person cards from this turn, only from what the owner wrote: the name must be in their message, and each field
   * is kept only when its words are there too (a mail read this turn cannot fill a card).
   */
  private async people(message: IncomingMessage, notes: PlanNotes): Promise<void> {
    const writer = this.ctx.tryUse(Contracts.peopleWrite);
    if (writer?.setProfile === undefined) return;
    const said = message.text.replace(/\s+/g, '');
    for (const person of (notes.people ?? []).slice(0, 3)) {
      const name = bareName(person.name);
      if (name.length < 2 || !said.includes(name.replace(/\s+/g, ''))) continue;
      const keep = (value: string): string => (fromOwner(value, said) ? value : '');
      await writer.setProfile({ name }, { title: keep(person.title), company: keep(person.company), relation: keep(person.relation), note: keep(person.note) }).catch(() => undefined);
    }
  }

  /** The people the owner described, so "대표님" or "김대리" means someone in every chat. */
  async peopleSection(): Promise<string | undefined> {
    const cards = (await this.ctx.tryUse(Contracts.peopleRead)?.cards?.().catch(() => [])) ?? [];
    if (cards.length === 0) return undefined;
    const line = (person: (typeof cards)[number]): string => {
      const profile = person.profile ?? {};
      const head = [profile.title, profile.company].filter((part) => part !== undefined && part !== '').join(', ');
      const parts = [head, profile.relation !== undefined ? (this.korean ? `관계: ${profile.relation}` : `relation: ${profile.relation}`) : undefined, profile.note?.replace(/\n/g, ' / ')];
      return `- ${person.names[0] ?? person.key}: ${parts.filter((part) => part !== undefined && part !== '').join(' · ')}`;
    };
    const title = this.korean ? '## 주인이 알려 준 사람들 (data; 고치거나 더하려면 notes.people)' : '## People the owner told you about (data; update them with notes.people)';
    // the cards hold words the model wrote down: screened like any other stored text
    return [title, ...cards.slice(0, 12).map((card) => guardText('person_card', line(card)).slice(0, 300))].join('\n');
  }

  async record(message: IncomingMessage, reply: string): Promise<void> {
    await this.timeline.add(message.conversation, labelOf(message.conversation, this.korean), message.text, reply).catch(() => undefined);
  }
}
