import { describe, expect, it } from 'vitest';
import type { MailMessage } from '../../../src/core/contracts/index.js';
import { authOf } from '../../../src/connectors/google/gmail.js';
import { needsReply, spoofReason, unsupportedFacts } from '../../../src/skills/mail/safety.js';

function mail(overrides: Partial<MailMessage> = {}): MailMessage {
  return { id: 'm', threadId: 't', from: 'Kim <kim@acme.co.kr>', to: [], cc: [], subject: 's', snippet: '', body: '', receivedAt: new Date(), unread: true, important: false, ...overrides };
}

describe('mail safety', () => {
  it('reads the receiving server’s verdicts', () => {
    expect(authOf('mx.google.com; dkim=pass header.i=@acme.co.kr; spf=softfail (google.com: …) smtp.mailfrom=x; dmarc=FAIL (p=REJECT) header.from=acme.co.kr')).toEqual({ auth: { spf: 'softfail', dkim: 'pass', dmarc: 'fail' } });
    expect(authOf(undefined)).toEqual({});
  });

  it('flags a forged sender: DMARC failed, SPF failed with no DKIM, or a name hiding another address', () => {
    expect(spoofReason(mail({ auth: { dmarc: 'fail', spf: 'pass', dkim: 'pass' } }))).toBe('dmarc');
    expect(spoofReason(mail({ auth: { spf: 'fail', dkim: 'none' } }))).toBe('spf-dkim');
    expect(spoofReason(mail({ auth: { spf: 'softfail', dkim: 'pass' } }))).toBeUndefined();
    expect(spoofReason(mail({ from: '"ceo@acme.co.kr" <acme.ceo@gmail.com>' }))).toBe('display-name');
    expect(spoofReason(mail({ from: 'kim@acme.co.kr <kim@acme.co.kr>' }))).toBeUndefined();
    expect(spoofReason(mail())).toBeUndefined();
  });

  it('writes no reply to robots, lists or notices', () => {
    expect(needsReply(mail(), 'question')).toBe(true);
    expect(needsReply(mail({ from: 'Shop <no-reply@shop.com>' }), 'question')).toBe(false);
    expect(needsReply(mail({ from: 'GitHub <notifications@github.com>' }), 'question')).toBe(false);
    expect(needsReply(mail({ bulk: true }), 'question')).toBe(false);
    expect(needsReply(mail(), 'notice')).toBe(false);
  });

  it('finds dates, times and amounts in a draft that no source mentions', () => {
    const sources = ['Subject: 견적\n11월 25일 오후 3시 회의 가능하세요? 예산은 1,200만원이에요.', '11월 26일(수) 14:00–16:00'];
    expect(unsupportedFacts('11월 25일 오후 3시에 뵙겠습니다. 1200만원 기준으로 준비할게요.', sources)).toEqual([]);
    expect(unsupportedFacts('12월 3일까지 1500만원으로 보내드릴게요. 14:00도 돼요.', sources)).toEqual(['12월 3일', '1500만원']);
  });
});
