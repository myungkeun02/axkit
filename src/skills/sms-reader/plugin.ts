import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { readSmsReaderConfig } from './config.js';
import { smsReaderTexts } from './locale.js';
import { PARCEL_JOB, checkParcels } from './parcels.js';
import { SmsReader } from './reader.js';

/**
 * 문자 읽기: reservations, parcels and bills from the text messages the phone forwards (`phone.sms`), and smishing
 * warnings. Opt-in with plugins["skill.sms-reader"].enabled = true; it then owns SMS reservations (chat-inbox stops).
 * Calendar, to-do and parcel lookups run as tool calls, so the policy executor and the stop switch apply.
 */
export interface SmsReaderOptions {
  /** Tests wait on the reader's queue through this. */
  onReader?: (reader: SmsReader) => void;
}

export function smsReaderSkill(options: SmsReaderOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.sms-reader',
      kind: 'skill',
      title: '문자 읽기 (reservations, parcels, bills, smishing warnings)',
    },
    setup(ctx) {
      const config = readSmsReaderConfig(ctx);
      const texts = smsReaderTexts(ctx.assistant.language);
      const reader = new SmsReader({ ctx, texts, config });
      options.onReader?.(reader);
      ctx.provide(Contracts.smsReader, { claim: (sms) => reader.claim(sms) });
      ctx.bus.on('phone.sms', (sms) => {
        reader.enqueue(sms);
      });
      ctx.scheduler.add({
        name: PARCEL_JOB,
        schedule: { kind: 'every', seconds: config.parcelCheckMinutes * 60 },
        run: () => checkParcels({ ctx, texts }),
      });
    },
  };
}
