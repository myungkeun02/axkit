import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { ConversationRef, IncomingMessage } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { QuestionResult } from '../../core/policy/questions.js';
import { botOfAddress } from '../../core/contracts/bots.js';
import { OWNER_THREAD, threadOf } from '../../core/conversation/thread.js';

const DISCORD = 'channel.discord';

const KEY = 'open-loops';
const MAX_ITEMS = 60;
/** Left alone this long without coming up again: ask once whether to just do the proposal. */
const QUIET_MS = 20 * 60 * 60 * 1000;
/** Older than this and never asked (the assistant was off): dropped without asking. */
const STALE_MS = 14 * 24 * 60 * 60 * 1000;
const SHOWN = 8;
/** A card that expired unanswered is asked again after this, up to MAX_ASKS cards in all. */
const RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_ASKS = 3;

const ItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  proposal: z.string(),
  conversation: z.object({ channelId: z.string(), address: z.string(), thread: z.string().optional() }),
  createdAt: z.string(),
  status: z.enum(['open', 'asked', 'done', 'dropped']),
  askedAt: z.string().optional(),
  /** Cards shown so far (each one expired unanswered, or was lost to a restart). */
  asks: z.number().optional(),
});

export type OpenItem = z.infer<typeof ItemSchema>;

/**
 * Where a follow-up goes, with its memory thread. Items stored before threads were kept lost it; the owner's Discord
 * main chat (anything on Discord that is not a bot room) is the owner's DM, so it gets the owner thread back.
 */
function refOf(ref: { channelId: string; address: string; thread?: string | undefined }): ConversationRef {
  const base = { channelId: ref.channelId, address: ref.address };
  if (ref.thread !== undefined) return { ...base, thread: ref.thread };
  const thread = threadOf(base) ?? (ref.channelId === DISCORD && botOfAddress(ref.address) === undefined ? OWNER_THREAD : undefined);
  return thread !== undefined ? { ...base, thread } : base;
}

function idOf(text: string, at: string): string {
  return `o${createHash('sha256').update(`${text}|${at}`).digest('hex').slice(0, 6)}`;
}

/**
 * Things left undecided in chat. Each is shown to the model while open, so a later turn can settle it; one the owner
 * never brings up again is asked about — "이건 이렇게 처리할까요?" — one card per sweep; an answer settles it for good, a
 * card left unanswered is asked once more later, a few times at most.
 */
export class OpenLoops {
  private items: OpenItem[] = [];
  private loaded = false;
  /** The item whose card is out now; no second card while one waits (quiet hours, or the owner is away). */
  private asking: string | undefined;

  constructor(private readonly ctx: PluginContext) {}

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    const parsed = z.array(ItemSchema).safeParse(await this.ctx.kv.get<unknown>(KEY));
    this.items = parsed.success ? parsed.data : [];
    this.loaded = true;
    // a card shown before a restart can no longer be answered here: its waiter is gone, so ask again later
    let reconciled = false;
    for (const item of this.items) {
      // older items lost their thread: put it back, so a follow-up runs in the owner's shared conversation
      if (item.conversation.thread === undefined && refOf(item.conversation).thread !== undefined) {
        item.conversation = refOf(item.conversation);
        reconciled = true;
      }
      if (item.status !== 'asked') continue;
      item.status = 'open';
      reconciled = true;
    }
    if (reconciled) await this.save();
  }

  /** On startup: items left `asked` by the last run go back to `open`. */
  async reconcile(): Promise<void> {
    await this.ensure();
  }

  private async save(): Promise<void> {
    this.items = this.items.slice(-MAX_ITEMS);
    await this.ctx.kv.set(KEY, this.items);
  }

  async add(conversation: ConversationRef, open: readonly { text: string; proposal: string }[]): Promise<void> {
    if (open.length === 0) return;
    await this.ensure();
    const at = this.ctx.clock.now().toISOString();
    for (const item of open) {
      const text = item.text.trim().slice(0, 200);
      if (text === '' || this.items.some((known) => known.status === 'open' && known.text === text)) continue;
      this.items.push({ id: idOf(text, at), text, proposal: item.proposal.trim().slice(0, 300), conversation: refOf(conversation), createdAt: at, status: 'open' });
    }
    await this.save();
  }

  async resolve(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensure();
    for (const item of this.items) if (ids.includes(item.id) && item.status === 'open') item.status = 'done';
    await this.save();
  }

  /** The prompt section: open items with ids, newest first. */
  async section(korean: boolean): Promise<string | undefined> {
    await this.ensure();
    const open = this.items.filter((item) => item.status === 'open').slice(-SHOWN).reverse();
    if (open.length === 0) return undefined;
    const head = korean
      ? '## 지난 대화에서 정하지 않은 일 (데이터; 오너가 이 중 하나를 정하거나 처리하면 그 id를 notes.resolved에 넣어요)'
      : '## Undecided from earlier chats (data; when the owner settles one, put its id in notes.resolved)';
    return [head, ...open.map((item) => `- ${item.id}: ${item.text}${item.proposal !== '' ? ` → ${korean ? '제안' : 'proposal'}: ${item.proposal}` : ''} (${item.createdAt.slice(0, 10)})`)].join('\n');
  }

  /**
   * The hourly sweep: at most one card, for the oldest item quiet for a day. Yes hands the proposal back to the
   * conversation it came from as the owner's own request; no closes it; no answer asks again later, a few times.
   */
  async followUp(korean: boolean): Promise<number> {
    await this.ensure();
    const now = this.ctx.clock.now().getTime();
    let next: OpenItem | undefined;
    for (const item of this.items) {
      if (item.status !== 'open' || now - Date.parse(item.createdAt) < QUIET_MS) continue;
      if (now - Date.parse(item.createdAt) > STALE_MS || item.proposal === '' || (item.asks ?? 0) >= MAX_ASKS) {
        item.status = 'dropped';
        continue;
      }
      if (item.askedAt !== undefined && now - Date.parse(item.askedAt) < RETRY_MS) continue;
      next ??= item;
    }
    if (next === undefined || this.asking !== undefined) {
      await this.save();
      return 0;
    }
    next.status = 'asked';
    next.askedAt = new Date(now).toISOString();
    next.asks = (next.asks ?? 0) + 1;
    await this.save();
    this.asking = next.id;
    const item = next;
    void this.ask(item, korean).finally(() => {
      if (this.asking === item.id) this.asking = undefined;
    });
    return 1;
  }

  private async ask(item: OpenItem, korean: boolean): Promise<void> {
    const questions = this.ctx.tryUse(Contracts.questions);
    if (questions === undefined) return;
    const answer = await questions
      .ask({
        topic: `assistant:open:${item.id}`,
        summary: korean ? `지난번 "${item.text}"은(는) 이렇게 처리할까요?` : `Shall I handle "${item.text}" like this?`,
        note: korean ? `제안: ${item.proposal}\n아니라고 하시면 더 묻지 않을게요.` : `Proposal: ${item.proposal}\nSay no and I will leave it.`,
        choices: [
          { id: 'yes', label: korean ? '그렇게 해 줘' : 'Do that', tone: 'primary', means: 'approved' },
          { id: 'no', label: korean ? '그냥 둘게' : 'Leave it', means: 'denied' },
        ],
        effects: ['write'],
        askedBy: 'skill.assistant',
      })
      .catch(() => undefined);
    await this.ensure();
    const stored = this.items.find((known) => known.id === item.id);
    if (stored !== undefined) stored.status = settle(answer, stored.asks ?? 1);
    await this.save();
    if (answer?.status !== 'answered' || answer.means !== 'approved' || answer.reused) return;
    const at = this.ctx.clock.now();
    const message: IncomingMessage = {
      id: `open-loop:${item.id}`,
      conversation: refOf(item.conversation),
      authorId: 'assistant:open-loop',
      // the owner pressed "그렇게 해 줘" on the card
      fromOwner: true,
      text: korean ? `(지난번 "${item.text}") 제안대로 처리해 줘: ${item.proposal}` : `(Earlier: "${item.text}") Go ahead as proposed: ${item.proposal}`,
      receivedAt: at,
    };
    void this.ctx.bus.emit('message.received', message);
  }
}

/** Answered yes: done. Answered otherwise or settled by topic: dropped. Unanswered: open again, until the last card. */
function settle(answer: QuestionResult | undefined, asks: number): OpenItem['status'] {
  if (answer?.status === 'answered') return answer.means === 'approved' ? 'done' : 'dropped';
  if (answer?.status === 'skipped') return 'dropped';
  return asks >= MAX_ASKS ? 'dropped' : 'open';
}
