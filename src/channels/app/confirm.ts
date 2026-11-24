import { randomUUID } from 'node:crypto';
import type { ConfirmAnswer, ConfirmOptions, ConfirmRequest, Confirmer, RememberOffer } from '../../core/policy/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { AppEventLog } from './log.js';
import type { AppTexts } from './locale.js';
import type { OutgoingImage } from '../../core/conversation/types.js';
import type { CardDecisionBody, CardOptionView, CardState, EventMedia } from './protocol.js';

export type CardDecision = 'approve' | 'deny' | 'edit';

interface PendingCard {
  resolve: (answer: ConfirmAnswer) => void;
  timer: unknown;
  summary: string;
  options: CardOptionView[];
  /** What each option means for the caller (approve / deny for plain confirmations). */
  means: Map<string, ConfirmAnswer>;
  remember?: RememberOffer;
  topic?: string;
  report?: ConfirmRequest['report'];
}

export interface AppConfirmerOptions {
  log: AppEventLog;
  clock: Clock;
  expiresMs: number;
  texts: AppTexts;
  newId?: () => string;
  /** Pictures of what will be sent (§7.5); without it cards carry none. */
  media?: (images: readonly OutgoingImage[] | undefined) => Promise<EventMedia>;
}

export type CardResult =
  | { state: CardState; answer?: string }
  | { state: 'gone' }
  | { state: 'bad_option' };

/** What a typed reply turns into: the owner's next instruction, tied to the card it answers. */
export interface CardReply {
  summary: string;
  text: string;
}

const OPTION_ANSWER: Record<string, ConfirmAnswer> = { approve: 'approved', deny: 'denied' };

/**
 * Confirmation cards in the app. Only the app's own route calls `decide`, and that route is reachable only with an
 * app-paired token, so an answer here is the owner's (approverKind 'user'): signal-only tokens cannot approve.
 * A card shows its options (approve = primary, deny = danger) and a text box; a typed reply is a "no" to this exact
 * action and becomes the owner's next message.
 */
function noteField(note: string | undefined): { note?: string } {
  return note !== undefined ? { note } : {};
}

/** 육하원칙 context first, then why the owner is asked (a guessed date). */
function cardNote(request: ConfirmRequest): string | undefined {
  const parts = [request.context, request.note].filter((part): part is string => part !== undefined && part.trim() !== '');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export class AppConfirmer implements Confirmer {
  private readonly pending = new Map<string, PendingCard>();
  private readonly newId: () => string;

  constructor(private readonly opts: AppConfirmerOptions) {
    this.newId = opts.newId ?? randomUUID;
  }

  async confirm(request: ConfirmRequest, options: ConfirmOptions = {}): Promise<ConfirmAnswer> {
    if (options.signal?.aborted === true) return 'expired';
    // R15: an open card on the same topic is updated in place (same id), never shown twice
    const open = request.topic === undefined ? undefined : [...this.pending.entries()].find(([, card]) => card.topic === request.topic);
    if (open !== undefined) this.supersede(open[0]);
    const cardId = open?.[0] ?? this.newId();
    const expiresAt = new Date(this.opts.clock.now().getTime() + this.opts.expiresMs);
    const media = request.images !== undefined && this.opts.media !== undefined ? await this.opts.media(request.images) : {};
    const cardOptions: CardOptionView[] =
      request.choices !== undefined && request.choices.length > 0
        ? request.choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            ...(choice.tone !== undefined ? { tone: choice.tone } : {}),
            ...(choice.detail !== undefined ? { detail: choice.detail } : {}),
          }))
        : [
            { id: 'approve', label: this.opts.texts.approveOption, tone: 'primary', detail: this.opts.texts.approveDetail },
            { id: 'deny', label: this.opts.texts.denyOption, tone: 'danger', detail: this.opts.texts.denyDetail },
          ];
    const means = new Map<string, ConfirmAnswer>(
      request.choices !== undefined && request.choices.length > 0
        ? request.choices.map((choice) => [choice.id, choice.means === 'approved' ? 'approved' : 'denied'])
        : [['approve', 'approved'], ['deny', 'denied']],
    );
    await this.opts.log.append({
      type: 'card',
      cardId,
      summary: request.summary,
      effects: [...request.effects],
      effectLabels: request.effects.map((effect) => this.opts.texts.effectLabels[effect]),
      ...noteField(cardNote(request)),
      expiresAt: expiresAt.toISOString(),
      options: cardOptions,
      freeText: true,
      ...(request.topic !== undefined ? { topic: request.topic } : {}),
      ...(request.remember !== undefined
        ? { remember: { label: request.remember.label, ...(request.remember.detail !== undefined ? { detail: request.remember.detail } : {}) } }
        : {}),
      ...media,
    });
    return await new Promise<ConfirmAnswer>((resolve) => {
      const timer = this.opts.clock.setTimeout(() => {
        void this.close(cardId, 'expired', 'expired');
      }, this.opts.expiresMs);
      this.pending.set(cardId, {
        resolve,
        timer,
        summary: request.summary,
        options: cardOptions,
        means,
        ...(request.remember !== undefined ? { remember: request.remember } : {}),
        ...(request.topic !== undefined ? { topic: request.topic } : {}),
        ...(request.report !== undefined ? { report: request.report } : {}),
      });
      options.signal?.addEventListener(
        'abort',
        () => {
          void this.close(cardId, 'closed', 'expired');
        },
        { once: true },
      );
    });
  }

  /** Applies one answer. A typed reply is returned so the route can pass it on as the owner's next message. */
  async answer(cardId: string, body: CardDecisionBody): Promise<{ result: CardResult; reply?: CardReply }> {
    const card = this.pending.get(cardId);
    if (card === undefined) return { result: { state: 'gone' } };
    if ('text' in body) {
      card.report?.({ text: body.text });
      await this.close(cardId, 'edit', 'denied', body.text);
      return { result: { state: 'edit', answer: body.text }, reply: { summary: card.summary, text: body.text } };
    }
    const optionId = 'option' in body ? body.option : body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : 'edit';
    if (optionId === 'edit') {
      // the old three-button form: "fix" is a no for this action, and the assistant asks what to change
      await this.close(cardId, 'edit', 'denied');
      await this.opts.log.append({ type: 'message', role: 'assistant', text: this.opts.texts.editPrompt });
      return { result: { state: 'edit' } };
    }
    const option = card.options.find((candidate) => candidate.id === optionId);
    const answer = card.means.get(optionId) ?? OPTION_ANSWER[optionId];
    if (option === undefined || answer === undefined) return { result: { state: 'bad_option' } };
    if (answer === 'approved' && 'option' in body && body.remember === true) {
      // the rule exists before the action runs, so a failure here is visible and the action still waits for nothing
      await card.remember?.accept().catch(() => undefined);
    }
    const state: CardState = answer === 'approved' ? 'approved' : 'denied';
    card.report?.({ choice: option.id });
    await this.close(cardId, state, answer, option.label);
    return { result: { state, answer: option.label } };
  }

  /** Old callers: approve / deny / edit. */
  async decide(cardId: string, decision: CardDecision): Promise<CardState | 'gone'> {
    const { result } = await this.answer(cardId, { decision });
    return result.state === 'bad_option' ? 'gone' : result.state;
  }

  /** The older question on a topic gives way to the newer one, which keeps its card id. */
  private supersede(cardId: string): void {
    const pending = this.pending.get(cardId);
    if (pending === undefined) return;
    this.pending.delete(cardId);
    this.opts.clock.clearTimeout(pending.timer);
    pending.resolve('expired');
  }

  /** After a restart nobody waits for old cards; mark them expired so clients drop their buttons. */
  async expireStale(): Promise<void> {
    for (const cardId of await this.opts.log.openCards()) {
      if (!this.pending.has(cardId)) await this.opts.log.append({ type: 'card_closed', cardId, state: 'expired' });
    }
  }

  private async close(cardId: string, state: Exclude<CardState, 'open'>, answer: ConfirmAnswer, label?: string): Promise<void> {
    const pending = this.pending.get(cardId);
    if (pending === undefined) return;
    this.pending.delete(cardId);
    this.opts.clock.clearTimeout(pending.timer);
    pending.resolve(answer);
    await this.opts.log.append({ type: 'card_closed', cardId, state, ...(label !== undefined ? { answer: label } : {}) });
  }
}
