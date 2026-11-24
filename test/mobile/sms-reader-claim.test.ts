import { describe, expect, it } from 'vitest';
import type { PaymentNotice, PhoneSms, SmsReaderClaims } from '../../src/core/contracts/index.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import type { MobileDevice } from '../../src/mobile/devices.js';
import { MobileIngest } from '../../src/mobile/ingest.js';
import { mobileTexts } from '../../src/mobile/locale.js';
import { OtpVault } from '../../src/mobile/otp.js';
import { SampleStore } from '../../src/mobile/samples.js';
import { SmsActions } from '../../src/mobile/sms-action.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';
import { ScriptedLlm } from '../support/context.js';

const NOW = new Date('2026-11-23T09:00:00+09:00');
const device: MobileDevice = {
  id: 'd_TESTTEST',
  name: 'phone',
  platform: 'ios',
  tokenHash: 'hash',
  createdAt: NOW.toISOString(),
  rotatedAt: NOW.toISOString(),
  failures: 0,
};

function bridge(reader: SmsReaderClaims | undefined) {
  const clock = new FakeClock(NOW);
  const kv = new MapKeyValueStore();
  const bus = new InMemoryEventBus(silentLogger);
  const llm = new ScriptedLlm();
  const sms = new SmsActions({ kv, llm, clock, log: silentLogger, texts: mobileTexts('ko'), notifier: () => undefined, todo: () => undefined });
  const ingest = new MobileIngest({
    samples: new SampleStore(kv, clock, 'Asia/Seoul'),
    otp: new OtpVault(clock),
    sms,
    bus,
    log: silentLogger,
    reader: () => reader,
  });
  const events: PhoneSms[] = [];
  const money: PaymentNotice[] = [];
  bus.on('phone.sms', (payload) => {
    events.push(payload);
  });
  bus.on('money.notice', (payload) => {
    money.push(payload);
  });
  return { ingest, events, money, llm };
}

const fakeReader: SmsReaderClaims = {
  claim: ({ text }) => (text.includes('스미싱') ? 'smishing' : text.includes('예약') ? 'notice' : undefined),
};

describe('bridge hands claimed text messages to the SMS reader', () => {
  it('sends a claimed card-looking smishing text as phone.sms and keeps it out of the ledger', async () => {
    const { ingest, events, money, llm } = bridge(fakeReader);
    await ingest.handle(device, NOW, [{ kind: 'sms', at: NOW, from: '010-0000-0000', text: '스미싱 해외결제 승인 980,000원' }]);
    await ingest.idle();
    expect(events).toHaveLength(1);
    expect(money).toHaveLength(0);
    // the reader owns it: no generic action check
    expect(llm.requests).toHaveLength(0);
  });

  it('a claimed notice that is also a card approval still reaches the ledger', async () => {
    const { ingest, events, money } = bridge(fakeReader);
    await ingest.handle(device, NOW, [{ kind: 'sms', at: NOW, from: '15880000', text: '[예시호텔] 예약 결제 승인 120,000원' }]);
    expect(events).toHaveLength(1);
    expect(money).toHaveLength(1);
  });

  it('never claims a one-time code, and without the reader nothing changes', async () => {
    const { ingest, events } = bridge({ claim: () => 'notice' });
    await ingest.handle(device, NOW, [{ kind: 'sms', at: NOW, text: '[Web발신] 예약 인증번호 482913 입니다' }]);
    expect(events).toHaveLength(0);

    const plain = bridge(undefined);
    await plain.ingest.handle(device, NOW, [{ kind: 'sms', at: NOW, text: '[예시카드] 승인 12,000원 일시불' }]);
    expect(plain.events).toHaveLength(0);
    expect(plain.money).toHaveLength(1);
  });
});
