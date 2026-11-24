import { createHash } from 'node:crypto';
import type { PaymentNotice } from '../core/contracts/money.js';
import type { SmsReaderClaims } from '../core/contracts/phone.js';
import type { EventBus } from '../core/events/types.js';
import type { Logger } from '../core/log/types.js';
import type { MobileDevice } from './devices.js';
import { extractOneTimeCode, isCardApproval, isSpam } from './locale-ko-rules.js';
import type { OtpVault } from './otp.js';
import type { SampleStore } from './samples.js';
import type { IngestItem } from './schema.js';
import type { SmsActions } from './sms-action.js';
import { ruleVerdict } from './sms-filter.js';

export interface IngestHandler {
  handle(device: MobileDevice, at: Date, items: readonly IngestItem[]): Promise<number>;
}

export interface MobileIngestOptions {
  samples: SampleStore;
  otp: OtpVault;
  sms: SmsActions;
  bus: EventBus;
  log: Logger;
  /** Resolved per message (skill.sms-reader may start after the bridge). */
  reader?: () => SmsReaderClaims | undefined;
}

/** Stores every signal locally, then fans out the events other skills consume. Content is data, never instructions. */
export class MobileIngest implements IngestHandler {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: MobileIngestOptions) {}

  async handle(device: MobileDevice, at: Date, items: readonly IngestItem[]): Promise<number> {
    await this.options.samples.record(items, at);
    for (const item of items) {
      if (item.kind === 'location') {
        await this.options.bus.emit('phone.location', {
          deviceId: device.id,
          location: {
            lat: item.lat,
            lng: item.lng,
            at: item.at,
            ...(item.label !== undefined ? { label: item.label } : {}),
          },
        });
      } else if (item.kind === 'voice_memo') {
        if (item.text.trim() !== '') {
          await this.options.bus.emit('phone.voice_memo', {
            deviceId: device.id,
            text: item.text,
            at: item.at,
          });
        }
      } else if (item.kind === 'sms') {
        this.options.otp.record(item.from, item.text, item.at);
        // Bills, reservations, parcels and smishing go to the SMS reader, even when they read like a card notice.
        const claim = this.claim(item.from, item.text);
        if (claim !== undefined) {
          // a real card approval for a booking still reaches the ledger; a smishing one never does
          if (claim === 'notice') await this.noticePayment(item.from, undefined, item.text, item.at, 'sms');
          await this.emitSms(device, item.from, item.text, item.at, true);
          continue;
        }
        if (await this.noticePayment(item.from, undefined, item.text, item.at, 'sms')) continue;
        await this.emitSms(device, item.from, item.text, item.at);
        this.later({
          kind: 'sms',
          text: item.text,
          at: item.at,
          ...(item.from !== undefined ? { from: item.from } : {}),
        });
      } else if (item.kind === 'notification') {
        this.options.otp.record(item.app, item.text, item.at);
        if (await this.noticePayment(item.app, item.title, item.text, item.at, 'app')) continue;
        this.later({
          kind: 'notification',
          app: item.app,
          text: item.text,
          at: item.at,
        });
      }
    }
    return items.length;
  }

  /** A one-time code is never claimed: it must not leave the vault. */
  private claim(from: string | undefined, text: string): 'notice' | 'smishing' | undefined {
    if (text.trim() === '' || extractOneTimeCode(text) !== undefined) return undefined;
    try {
      return this.options.reader?.()?.claim({ text, ...(from !== undefined ? { from } : {}) });
    } catch {
      return undefined;
    }
  }

  /** Card notices go to the spending skill as data; chat and the model never see them. */
  private async noticePayment(
    sender: string | undefined,
    title: string | undefined,
    text: string,
    at: Date,
    source: 'sms' | 'app',
  ): Promise<boolean> {
    if (!isCardApproval(text) || isSpam(text, sender)) return false;
    const notice: PaymentNotice = {
      source,
      ...(sender !== undefined && sender !== '' ? { sender } : {}),
      ...(title !== undefined && title !== '' ? { title } : {}),
      text,
      at,
    };
    await this.options.bus.emit('money.notice', notice);
    return true;
  }

  /**
   * Plain messages (no code, card approval or spam) go out as `phone.sms` so other skills can look for appointments.
   * Listeners must not wait on a model inside the handler.
   */
  private async emitSms(device: MobileDevice, from: string | undefined, text: string, at: Date, claimed = false): Promise<void> {
    if (text.trim() === '' || (!claimed && ruleVerdict(text, from) !== undefined)) return;
    const ref = createHash('sha256').update(`${from ?? ''}\n${at.toISOString()}\n${text}`).digest('hex').slice(0, 24);
    await this.options.bus.emit('phone.sms', {
      deviceId: device.id,
      text,
      at,
      ref: `sms:${ref}`,
      ...(from !== undefined && from !== '' ? { from } : {}),
    });
  }

  /** A model call can take seconds; the phone's request must not wait for it. */
  private later(message: Parameters<SmsActions['handle']>[0]): void {
    this.pending = this.pending.then(() => this.handleMessage(message));
  }

  /** Resolves once queued message checks are done (tests, shutdown). */
  idle(): Promise<void> {
    return this.pending;
  }

  private async handleMessage(message: Parameters<SmsActions['handle']>[0]): Promise<void> {
    try {
      await this.options.sms.handle(message);
    } catch (error) {
      this.options.log.warn('mobile: message handling failed', {
        kind: message.kind,
        error: error instanceof Error ? error.name : 'error',
      });
    }
  }
}
