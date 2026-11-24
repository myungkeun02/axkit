import { randomUUID } from 'node:crypto';
import type { ConfirmAnswer, ConfirmOptions, ConfirmRequest, Confirmer, Effect } from '../../core/policy/types.js';
import type { DiscordButtonPress, DiscordPort } from './port.js';

export interface ConfirmTexts {
  approve: string;
  deny: string;
  effectsLabel: string;
  noteLabel: string;
  effectLabels: Record<Effect, string>;
  approvedNote: string;
  deniedNote: string;
  expiredNote: string;
  /** The same card was answered in another channel (the phone app). */
  closedNote: string;
}

export interface DiscordConfirmerOptions {
  port: DiscordPort;
  ownerUserId: string;
  expiresMs: number;
  texts: ConfirmTexts;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  newId?: () => string;
}

interface PendingConfirm {
  channelId: string;
  messageId: string;
  resolve: (answer: ConfirmAnswer) => void;
  timer: unknown;
}

const CONFIRM_ID = /^confirm:([^:]+):(yes|no)$/;

export class DiscordConfirmer implements Confirmer {
  private readonly pending = new Map<string, PendingConfirm>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly newId: () => string;

  constructor(private readonly opts: DiscordConfirmerOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.newId = opts.newId ?? randomUUID;
  }

  async confirm(request: ConfirmRequest, options: ConfirmOptions = {}): Promise<ConfirmAnswer> {
    if (options.signal?.aborted === true) return 'expired';
    const id = this.newId();
    const channelId = await this.opts.port.openDm(this.opts.ownerUserId);
    const { messageId } = await this.opts.port.send(channelId, {
      content: this.card(request),
      buttons: [
        { customId: `confirm:${id}:yes`, label: this.opts.texts.approve, style: 'success' },
        { customId: `confirm:${id}:no`, label: this.opts.texts.deny, style: 'danger' },
      ],
    });

    return await new Promise<ConfirmAnswer>((resolve) => {
      const timer = this.setTimer(() => {
        void this.expire(id);
      }, this.opts.expiresMs);
      this.pending.set(id, { channelId, messageId, resolve, timer });
      options.signal?.addEventListener(
        'abort',
        () => {
          void this.expire(id, this.opts.texts.closedNote);
        },
        { once: true },
      );
    });
  }

  /**
   * Returns true for any id in the confirm namespace, even stale or non-owner presses: the caller
   * must not treat those as choice buttons. Only the owner's first press resolves the promise.
   */
  async handleButton(press: DiscordButtonPress): Promise<boolean> {
    const match = CONFIRM_ID.exec(press.customId);
    if (match === null) return false;
    await this.ack(press);

    const id = match[1];
    if (id === undefined) return true;
    const pending = this.pending.get(id);
    if (pending === undefined) return true;
    if (press.userId !== this.opts.ownerUserId) return true;

    this.pending.delete(id);
    this.clearTimer(pending.timer);
    const approved = match[2] === 'yes';
    await this.finish(pending, approved ? this.opts.texts.approvedNote : this.opts.texts.deniedNote);
    pending.resolve(approved ? 'approved' : 'denied');
    return true;
  }

  private async expire(id: string, note = this.opts.texts.expiredNote): Promise<void> {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.clearTimer(pending.timer);
    await this.finish(pending, note);
    pending.resolve('expired');
  }

  private card(request: ConfirmRequest): string {
    const effects = request.effects.map((effect) => this.opts.texts.effectLabels[effect]).join(', ');
    const reason = [request.context, request.note].filter((part) => part !== undefined && part.trim() !== '').join(' ');
    const note = reason === '' ? '' : `\n${this.opts.texts.noteLabel} ${reason}`;
    return `${request.summary}\n\n${this.opts.texts.effectsLabel} ${effects}${note}`;
  }

  private async ack(press: DiscordButtonPress): Promise<void> {
    try {
      await press.ack();
    } catch {
      // The interaction can expire before we answer; the button is spent either way.
    }
  }

  private async finish(pending: PendingConfirm, note: string): Promise<void> {
    try {
      await this.opts.port.editComponentsOff(pending.channelId, pending.messageId, note);
    } catch {
      // The decision still stands when the UI update fails.
    }
  }
}
