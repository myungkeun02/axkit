import { createHash } from 'node:crypto';
import type { AuditLog, Logger } from '../log/types.js';
import type { AutonomyRule, AutonomyRules } from './autonomy.js';
import type { OwnerQuestions, QuestionResult } from './questions.js';
import type { ScopeTrack, SqliteScopeTracks, TrackScope } from './promotion.js';
import { DEMOTE_FAILS_IN_A_ROW, PROMOTE_ASK_AGAIN_AFTER, cleanApprovals, promotionVerdict } from './promotion.js';
import type { ConfirmChoice } from './types.js';

/** What the executor tells about cards and actions of a scope. Never throws into the action. */
export interface AutonomyTracker {
  answered(scope: TrackScope, answer: 'approved' | 'denied' | 'edited'): Promise<void>;
  /** `rule` is set when the action ran on its own under that rule. */
  finished(scope: TrackScope, result: { ok: boolean; rule?: AutonomyRule }): Promise<void>;
}

/** What the app view and the "that was wrong" tool use. */
export interface AutonomyPromotion {
  /** The owner undid or complained about the latest action of `tool`: counted, and a promoted rule pauses. */
  corrected(tool: string): Promise<{ label: string; paused: boolean } | undefined>;
  counts(rule: AutonomyRule): { approved: number; denied: number; edited: number; corrected: number } | undefined;
}

export interface PromoterOptions {
  tracks: SqliteScopeTracks;
  rules: AutonomyRules;
  questions: () => OwnerQuestions | undefined;
  /** A short notice to the owner (paused rules). */
  notify: (text: string) => void;
  audit?: AuditLog;
  log: Logger;
  language: string;
}

type PauseReason = 'failed' | 'corrected';

export function promotionTopic(tool: string, scope: string): string {
  const hash = createHash('sha256').update(scope).digest('hex').slice(0, 16);
  return `autonomy:promote:${tool.replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 80)}:${hash}`;
}

function texts(ko: boolean) {
  return {
    question: (clean: number, total: number) =>
      ko
        ? `이 일은 지난 ${clean === total ? `${clean}번 모두` : `${total}번 중 ${clean}번`} 승인하셨어요. 앞으로는 알아서 하고 결과만 알려 드릴까요?`
        : `You approved this ${clean === total ? `all ${clean} times` : `${clean} of the last ${total} times`}. Shall I just do it from now on and tell you the result?`,
    choices: [
      { id: 'yes', means: 'approved', tone: 'primary', label: ko ? '네, 알아서 해 주세요' : 'Yes, just do it', detail: ko ? '같은 범위의 일은 묻지 않고 하고, 한 뒤에 알려 드려요' : 'Done without a card, and you hear about it after' },
      { id: 'later', means: 'denied', tone: 'neutral', label: ko ? '지금은 말고요' : 'Not now', detail: ko ? `${PROMOTE_ASK_AGAIN_AFTER}번 더 승인하시면 다시 여쭤볼게요` : `Asked again after ${PROMOTE_ASK_AGAIN_AFTER} more approvals` },
      { id: 'never', means: 'denied', tone: 'danger', label: ko ? '계속 물어봐 주세요' : 'Keep asking me', detail: ko ? '이 일은 앞으로도 카드로 여쭤볼게요' : 'This stays on cards' },
    ] satisfies ConfirmChoice[],
    paused: (label: string, reason: PauseReason) =>
      ko
        ? `알아서 하던 일을 멈췄어요: ${label}. ${reason === 'failed' ? '연달아 두 번 실패했어요.' : '바로잡아 달라고 하셔서요.'} 다음부터는 다시 여쭤볼게요. '알아서 하는 일' 화면에서 다시 켤 수 있어요.`
        : `I stopped doing this on my own: ${label}. ${reason === 'failed' ? 'It failed twice in a row.' : 'You asked me to fix it.'} I will ask again; you can turn it back on in the autonomy view.`,
  };
}

/**
 * "자동 실행 승격": a narrow kind of action the owner approved many times, always rightly, is offered once to run on its
 * own. A yes makes an ordinary autonomy rule (origin "promoted", revocable in the autonomy view); a promoted rule that
 * fails twice in a row or that the owner corrects is paused and the owner is told once.
 */
export class AutonomyPromoter implements AutonomyTracker, AutonomyPromotion {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly opts: PromoterOptions) {}

  answered(scope: TrackScope, answer: 'approved' | 'denied' | 'edited'): Promise<void> {
    return this.guard(() => {
      this.opts.tracks.count(scope, answer);
      return Promise.resolve();
    });
  }

  finished(scope: TrackScope, result: { ok: boolean; rule?: AutonomyRule }): Promise<void> {
    return this.guard(async () => {
      const { tracks } = this.opts;
      if (result.rule !== undefined) {
        const track = tracks.finished(scope, { ok: result.ok });
        if (!result.ok && result.rule.origin === 'promoted' && track.autoFails >= DEMOTE_FAILS_IN_A_ROW) {
          await this.pause(result.rule, track, 'failed');
        }
        return;
      }
      if (!result.ok) {
        tracks.count(scope, 'failed');
        tracks.finished(scope, undefined);
        return;
      }
      const track = tracks.finished(scope, undefined);
      if (scope.effects.includes('send') && scope.recipient !== undefined) tracks.sawRecipient(scope.recipient);
      // the card for the offer never holds up the action that was just approved
      this.pending = this.pending.then(() => this.guard(() => this.maybeAsk(track)));
    });
  }

  async corrected(tool: string): Promise<{ label: string; paused: boolean } | undefined> {
    const latest = this.opts.tracks.latest(tool);
    if (latest === undefined) return undefined;
    const track = this.opts.tracks.count(latest, 'corrected');
    const rule = await this.opts.rules.find(tool, track.scope);
    const paused = rule !== undefined && rule.origin === 'promoted' && rule.paused === undefined ? await this.pause(rule, track, 'corrected') : false;
    return { label: track.label, paused };
  }

  counts(rule: AutonomyRule): { approved: number; denied: number; edited: number; corrected: number } | undefined {
    const track = this.opts.tracks.get(rule.tool, rule.scope);
    return track === undefined ? undefined : { approved: cleanApprovals(track), denied: track.denied, edited: track.edited, corrected: track.corrected };
  }

  /** Resolves when every offer started so far has been answered (tests, shutdown). */
  settled(): Promise<void> {
    return this.pending;
  }

  private async maybeAsk(track: ScopeTrack): Promise<void> {
    const clean = cleanApprovals(track);
    const due = track.askState === 'none' || (track.askState === 'later' && clean >= track.askAfter);
    if (!due) return;
    const existing = await this.opts.rules.find(track.tool, track.scope);
    if (existing !== undefined) {
      this.opts.tracks.setAsk(track.tool, track.scope, 'yes');
      return;
    }
    const verdict = promotionVerdict(track, { recipientSeen: this.opts.tracks.recipientSeen(track.recipient) });
    if (!verdict.ok) return;
    const questions = this.opts.questions();
    if (questions === undefined) return;
    if (!this.opts.tracks.claimAsk(track.tool, track.scope, track.askState)) return;
    const t = texts(this.opts.language !== 'en');
    let result: QuestionResult;
    try {
      result = await questions.ask({
        topic: promotionTopic(track.tool, track.scope),
        facts: `n:${clean}`,
        summary: t.question(verdict.clean, verdict.total),
        note: track.detail !== undefined ? `${track.label} · ${track.detail}` : track.label,
        choices: t.choices,
        effects: ['write'],
        askedBy: 'core.autonomy',
      });
    } catch (error) {
      this.opts.tracks.setAsk(track.tool, track.scope, track.askState);
      throw error;
    }
    await this.settle(track, clean, result);
  }

  private async settle(track: ScopeTrack, clean: number, result: QuestionResult): Promise<void> {
    const { tracks } = this.opts;
    if (result.status === 'answered' && result.means === 'approved') {
      const rule = await this.opts.rules.add(
        track.tool,
        { key: track.scope, label: track.label, ...(track.detail !== undefined ? { detail: track.detail } : {}) },
        'promoted',
      );
      tracks.setAsk(track.tool, track.scope, 'yes');
      await this.opts.audit?.append({ at: new Date(), kind: 'autonomy.promote', subject: track.tool, detail: { rule: rule.id, approvals: clean } }).catch(() => undefined);
      return;
    }
    if (result.status === 'answered' && result.choice === 'never') {
      tracks.setAsk(track.tool, track.scope, 'never');
      return;
    }
    // not now, a typed reply, no answer: once more after enough further approvals
    tracks.setAsk(track.tool, track.scope, 'later', clean + PROMOTE_ASK_AGAIN_AFTER);
  }

  private async pause(rule: AutonomyRule, track: ScopeTrack, reason: PauseReason): Promise<boolean> {
    const paused = await this.opts.rules.pause(rule.id);
    this.opts.tracks.setAsk(track.tool, track.scope, 'paused');
    this.opts.tracks.finished(track, { ok: true });
    if (!paused) return false;
    await this.opts.audit?.append({ at: new Date(), kind: 'autonomy.pause', subject: rule.tool, detail: { rule: rule.id, reason } }).catch(() => undefined);
    this.opts.notify(texts(this.opts.language !== 'en').paused(rule.label, reason));
    return true;
  }

  private async guard(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.opts.log.warn('autonomy promotion failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
