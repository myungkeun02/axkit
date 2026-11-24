import type { QuietGate } from '../notify/quiet-gate.js';
import type { ConfirmChoice, Confirmer, Effect, RememberOffer } from './types.js';
import type { TopicAnswers } from './topics.js';
import { DEFAULT_LATER_MS, TOPIC, decideTopic } from './topics.js';

export interface QuestionRequest {
  topic: string;
  /** What the answer depends on (a document id, an amount); a "no" holds until this changes. */
  facts?: string;
  /** The short question ("이걸로 개발해 볼까요?"). */
  summary: string;
  /** Who, when, what, why: one or two plain sentences. */
  note?: string;
  choices: readonly ConfirmChoice[];
  effects?: readonly Effect[];
  /** Shown in the audit trail: who asked ("skill.recordings"). */
  askedBy: string;
  remember?: RememberOffer;
  /** When "later" brings it back (default about a day). */
  laterMs?: number;
  /**
   * Asked on the assistant's own initiative (the default): the card waits for quiet hours to end unless the owner is
   * awake and chatting. Pass false when the question is part of a reply to the owner.
   */
  proactive?: boolean;
}

export type QuestionResult =
  | { status: 'answered'; choice: string; means: ConfirmChoice['means']; text?: string; reused: boolean }
  | { status: 'skipped'; reason: 'declined' | 'later' | 'reopened_once' }
  | { status: 'expired' };

/**
 * Proactive questions to the owner (a skill asking, not a tool call), keyed by topic so none is asked twice. The card
 * goes through the same channels as every confirmation; the owner's answer is remembered per topic.
 */
export class OwnerQuestions {
  constructor(
    private readonly opts: { topics: TopicAnswers; confirmer: () => Confirmer | undefined; now: () => Date; gate?: QuietGate },
  ) {}

  async ask(request: QuestionRequest): Promise<QuestionResult> {
    if (!TOPIC.test(request.topic)) throw new Error(`Invalid topic: ${request.topic}`);
    const previous = await this.opts.topics.get(request.topic);
    const decision = decideTopic(previous, request.facts, this.opts.now());
    if (decision.kind === 'reuse') {
      const choice = decision.answer.choice ?? request.choices.find((c) => c.means === 'approved')?.id ?? 'approve';
      return { status: 'answered', choice, means: 'approved', reused: true };
    }
    if (decision.kind === 'skip') return { status: 'skipped', reason: decision.reason };
    const gate = this.opts.gate;
    if (request.proactive !== false && gate?.shouldWait() === true) {
      // no card at 3am: wait for the morning, then decide again (the topic may have been settled meanwhile)
      await gate.wait();
      return await this.ask({ ...request, proactive: false });
    }
    if (decision.reopening) await this.opts.topics.markReopened(request.topic);

    const confirmer = this.opts.confirmer();
    if (confirmer === undefined) return { status: 'expired' };
    let reported: { choice?: string; text?: string } | undefined;
    const answer = await confirmer.confirm({
      summary: request.summary,
      effects: request.effects ?? ['write'],
      toolName: request.askedBy,
      topic: request.topic,
      choices: request.choices,
      ...(request.note !== undefined ? { note: request.note } : {}),
      ...(request.remember !== undefined ? { remember: request.remember } : {}),
      report: (value) => {
        reported = value;
      },
    });
    if (answer === 'expired' && reported === undefined) return { status: 'expired' };
    const facts = request.facts !== undefined ? { facts: request.facts } : {};
    if (reported?.text !== undefined) {
      await this.opts.topics.record(request.topic, { answer: 'text', label: reported.text, ...facts });
      return { status: 'answered', choice: 'text', means: 'denied', text: reported.text, reused: false };
    }
    // a channel without choices answers yes / no: take the first choice that means the same
    const chosen =
      request.choices.find((c) => c.id === reported?.choice) ??
      request.choices.find((c) => c.means === (answer === 'approved' ? 'approved' : 'denied'));
    if (chosen === undefined) return { status: 'expired' };
    await this.opts.topics.record(request.topic, {
      answer: chosen.means,
      choice: chosen.id,
      label: chosen.label,
      ...facts,
      ...(chosen.means === 'later' ? { laterUntil: new Date(this.opts.now().getTime() + (request.laterMs ?? DEFAULT_LATER_MS)) } : {}),
    });
    return { status: 'answered', choice: chosen.id, means: chosen.means, reused: false };
  }
}
