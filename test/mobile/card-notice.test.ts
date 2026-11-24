import { describe, expect, it } from 'vitest';
import type { PaymentNotice } from '../../src/core/contracts/money.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import type { LlmRequest } from '../../src/core/llm/types.js';
import type { MobileDevice } from '../../src/mobile/devices.js';
import { MobileIngest } from '../../src/mobile/ingest.js';
import { isCardApproval } from '../../src/mobile/locale-ko-rules.js';
import { mobileTexts } from '../../src/mobile/locale.js';
import { OtpVault } from '../../src/mobile/otp.js';
import { SampleStore } from '../../src/mobile/samples.js';
import type { IngestItem } from '../../src/mobile/schema.js';
import { SmsActions } from '../../src/mobile/sms-action.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';
import { ScriptedLlm } from '../support/context.js';
import { NOW, seededRandom } from './helpers.js';

const device: MobileDevice = {
  id: 'd_TESTTEST',
  name: 'phone',
  platform: 'ios',
  tokenHash: 'hash',
  createdAt: NOW.toISOString(),
  rotatedAt: NOW.toISOString(),
  failures: 0,
};

function make(script: (string | ((request: LlmRequest) => string))[] = []) {
  const clock = new FakeClock(NOW);
  const kv = new MapKeyValueStore();
  const bus = new InMemoryEventBus(silentLogger);
  const llm = new ScriptedLlm(script);
  const ingest = new MobileIngest({
    samples: new SampleStore(kv, clock, 'Asia/Seoul'),
    otp: new OtpVault(clock),
    sms: new SmsActions({
      kv,
      llm,
      clock,
      log: silentLogger,
      texts: mobileTexts('ko'),
      notifier: () => undefined,
      todo: () => undefined,
      randomBytes: seededRandom(9),
    }),
    bus,
    log: silentLogger,
  });
  const notices: PaymentNotice[] = [];
  bus.on('money.notice', (notice) => {
    notices.push(notice);
  });
  return { ingest, notices, llm };
}

describe('phone card notices', () => {
  it('emits a card SMS as a money notice and keeps the model out', async () => {
    const { ingest, notices, llm } = make();
    const text = '카드 승인 12,000원 일시불';

    await ingest.handle(device, NOW, [{ kind: 'sms', at: NOW, from: '카드사', text }]);

    expect(notices).toEqual([{ source: 'sms', sender: '카드사', text, at: NOW }]);
    expect(llm.requests).toHaveLength(0);
  });

  it('carries the app name and notification title', async () => {
    const { ingest, notices } = make();
    const item: IngestItem = {
      kind: 'notification',
      at: NOW,
      app: '카드앱',
      title: '결제 알림',
      text: '카드 결제 8,500원',
    };

    await ingest.handle(device, NOW, [item]);

    expect(notices).toEqual([
      { source: 'app', sender: '카드앱', title: '결제 알림', text: '카드 결제 8,500원', at: NOW },
    ]);
  });

  it('emits foreign-currency notices', async () => {
    const { ingest, notices } = make();

    await ingest.handle(device, NOW, [
      { kind: 'sms', at: NOW, from: '카드사', text: '해외승인 US$12.34' },
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ source: 'sms', text: '해외승인 US$12.34' });
  });

  it('does not emit for ordinary messages, codes or spam', async () => {
    const normal = make();
    await normal.ingest.handle(device, NOW, [{ kind: 'sms', at: NOW, text: '내일 점심 어때요' }]);
    await normal.ingest.idle();
    expect(normal.notices).toHaveLength(0);

    const code = make();
    await code.ingest.handle(device, NOW, [
      { kind: 'sms', at: NOW, from: 'example', text: '인증번호 482913' },
    ]);
    await code.ingest.idle();
    expect(code.notices).toHaveLength(0);
    expect(code.llm.requests).toHaveLength(0);

    const spam = make();
    await spam.ingest.handle(device, NOW, [
      { kind: 'sms', at: NOW, from: 'example', text: '[광고] 카드 승인 12,000원 무료 수신 거부' },
    ]);
    await spam.ingest.idle();
    expect(spam.notices).toHaveLength(0);
  });
});

describe('card approval rule', () => {
  it('recognises foreign amounts only with card wording', () => {
    expect(isCardApproval('USD 12.34 승인')).toBe(true);
    expect(isCardApproval('US$12.34 결제')).toBe(true);
    expect(isCardApproval('EUR 10.00 취소')).toBe(true);
    expect(isCardApproval('해외 JPY 1,200 승인')).toBe(true);
    expect(isCardApproval('12.34 USD 결제')).toBe(true);
  });

  it('leaves prices, codes and ads alone', () => {
    expect(isCardApproval('USD 12.34 할인 쿠폰')).toBe(false);
    expect(isCardApproval('해외결제 인증번호 123456')).toBe(false);
    expect(isCardApproval('[광고] 해외결제 USD 12.34 이벤트')).toBe(false);
    expect(isCardApproval('내일 점심 어때요')).toBe(false);
  });
});
