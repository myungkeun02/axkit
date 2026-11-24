import { describe, expect, it } from 'vitest';
import type { PhoneSms } from '../../../src/core/contracts/index.js';
import { InMemoryEventBus } from '../../../src/core/events/bus.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import type { MobileDevice } from '../../../src/mobile/devices.js';
import { MobileIngest } from '../../../src/mobile/ingest.js';
import { mobileTexts } from '../../../src/mobile/locale.js';
import { OtpVault } from '../../../src/mobile/otp.js';
import { SampleStore } from '../../../src/mobile/samples.js';
import { SmsActions } from '../../../src/mobile/sms-action.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { ScriptedLlm } from '../../support/context.js';
import { NOW, setup } from './helpers.js';

const ANSWER = JSON.stringify({
  found: true,
  title: '치과 예약',
  date: { kind: 'offset', days: 1 },
  time: { hour: 3, minute: 0, meridiem: 'pm' },
  evidence: '내일 오후 3시',
});

function sms(overrides: Partial<PhoneSms> = {}): PhoneSms {
  return { deviceId: 'd1', from: '예시치과', text: '[예시치과] 내일 오후 3시 예약 확인 부탁드립니다', at: NOW, ref: 'sms:1', ...overrides };
}

describe('chat-inbox text-message appointments', () => {
  it('is off by default', async () => {
    const context = await setup({ llm: new ScriptedLlm() });
    await context.bus.emit('phone.sms', sms());
    expect(await context.kv.get<unknown[]>('queue')).toBeUndefined();
  });

  it('runs a text message through the same quoted-evidence flow and confirmation card', async () => {
    const llm = new ScriptedLlm([ANSWER]);
    const context = await setup({ llm, config: { sms: true } });
    await context.bus.emit('phone.sms', sms());
    await context.bus.emit('phone.sms', sms());
    expect(await context.kv.get<unknown[]>('queue')).toHaveLength(1);

    await context.scheduler.run('chat-inbox.appointments', NOW);

    expect(llm.requests[0]?.messages[1]?.content).toContain('"app":"sms"');
    const notice = context.notifier.notices[0]!;
    expect(notice).toMatchObject({ kind: 'chat.appointment', dedupeKey: 'sms:1' });
    expect(notice.text).toContain('문자 · 예시치과');
    expect(notice.choices).toHaveLength(2);
    // a text message never becomes a contact or a pending reply
    expect(context.people.calls).toHaveLength(0);
    expect(await context.kv.get<unknown[]>('pending')).toBeUndefined();
  });

  it('skips lines without a date or time word and muted senders', async () => {
    const context = await setup({ llm: new ScriptedLlm(), config: { sms: true } });
    await context.bus.emit('phone.sms', sms({ text: '택배가 문 앞에 놓였습니다', ref: 'sms:2' }));
    await context.ctx.bus.emit('tuning.apply', { domain: 'chat.appointment', action: 'mute', subject: 'sms:예시치과' } as never);
    await context.bus.emit('phone.sms', sms({ ref: 'sms:3' }));
    expect(await context.kv.get<unknown[]>('queue')).toBeUndefined();
  });
});

describe('bridge emits phone.sms only for plain messages', () => {
  const device: MobileDevice = {
    id: 'd_TESTTEST',
    name: 'phone',
    platform: 'ios',
    tokenHash: 'hash',
    createdAt: NOW.toISOString(),
    rotatedAt: NOW.toISOString(),
    failures: 0,
  };

  it('keeps codes, card approvals and spam out of the event', async () => {
    const clock = new FakeClock(NOW);
    const kv = new MapKeyValueStore();
    const bus = new InMemoryEventBus(silentLogger);
    const smsActions = new SmsActions({
      kv,
      llm: new ScriptedLlm(['{"action":null}']),
      clock,
      log: silentLogger,
      texts: mobileTexts('ko'),
      notifier: () => undefined,
      todo: () => undefined,
    });
    const ingest = new MobileIngest({
      samples: new SampleStore(kv, clock, 'Asia/Seoul'),
      otp: new OtpVault(clock),
      sms: smsActions,
      bus,
      log: silentLogger,
    });
    const seen: PhoneSms[] = [];
    bus.on('phone.sms', (payload) => {
      seen.push(payload);
    });
    await ingest.handle(device, NOW, [
      { kind: 'sms', at: NOW, from: 'example', text: '[Web발신] 인증번호 482913 입니다' },
      { kind: 'sms', at: NOW, from: '예시치과', text: '내일 오후 3시 예약입니다' },
    ]);
    await ingest.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ from: '예시치과', text: '내일 오후 3시 예약입니다' });
    expect(seen[0]?.ref).toMatch(/^sms:[0-9a-f]{24}$/);
  });
});
