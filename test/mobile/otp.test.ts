import { describe, expect, it } from 'vitest';
import { OtpVault } from '../../src/mobile/otp.js';
import { extractOneTimeCode, isCardApproval, isSpam } from '../../src/mobile/locale-ko-rules.js';
import { FakeClock } from '../core/helpers.js';
import { NOW } from './helpers.js';

function make() {
  const clock = new FakeClock(NOW);
  const vault = new OtpVault(clock);
  return { clock, vault };
}

describe('one-time code extraction', () => {
  it('finds a 4-8 digit code in Korean verification wording', () => {
    expect(extractOneTimeCode('[Web발신] 인증번호 482913 입니다')).toBe('482913');
    expect(extractOneTimeCode('승인번호 1234567')).toBe('1234567');
    expect(extractOneTimeCode('인증번호는 1234')).toBe('1234');
  });

  it('finds an English verification code', () => {
    expect(extractOneTimeCode('Your verification code is 123456')).toBe('123456');
    expect(extractOneTimeCode('Use this one-time passcode: 9876')).toBe('9876');
  });

  it('ignores numbers without verification wording or outside the 4-8 digit range', () => {
    expect(extractOneTimeCode('주문번호 12345678')).toBeUndefined();
    expect(extractOneTimeCode('인증번호 123')).toBeUndefined();
    expect(extractOneTimeCode('인증번호 123456789')).toBeUndefined();
    expect(extractOneTimeCode('내일 점심 어때요')).toBeUndefined();
  });
});

describe('OtpVault', () => {
  it('keeps the newest code with its source', async () => {
    const { clock, vault } = make();
    expect(vault.record('example', '인증번호 111111', NOW)).toBe(true);
    await clock.advance(1000);
    expect(vault.record('메일', 'Your verification code is 222222', clock.now())).toBe(true);

    const latest = vault.latest();

    expect(latest?.code).toBe('222222');
    expect(latest?.source).toBe('메일');
    expect(latest?.at).toEqual(clock.now());
  });

  it('ignores text without a code and non-code sources are not recorded', () => {
    const { vault } = make();
    expect(vault.record(undefined, '안녕하세요', NOW)).toBe(false);
    expect(vault.latest()).toBeUndefined();
  });

  it('drops codes after ten minutes', async () => {
    const { clock, vault } = make();
    vault.record('example', '인증번호 482913', NOW);

    await clock.advance(10 * 60_000);
    expect(vault.latest()?.code).toBe('482913');
    await clock.advance(1);
    expect(vault.latest()).toBeUndefined();
  });

  it('honors a shorter max age than the TTL', async () => {
    const { clock, vault } = make();
    vault.record('example', '인증번호 482913', NOW);

    await clock.advance(2 * 60_000);
    expect(vault.latest(1)).toBeUndefined();
    expect(vault.latest()).toBeDefined();
  });
});

describe('SMS rules', () => {
  it('recognizes card approvals', () => {
    expect(isCardApproval('카드 승인 12,000원 일시불')).toBe(true);
    expect(isCardApproval('내일 시간 괜찮아?')).toBe(false);
  });

  it('recognizes spam markers', () => {
    expect(isSpam('[광고] 무료 수신 거부 080-1234-5678', 'example')).toBe(true);
    expect(isSpam('저금리 대출 한도 조회 안내', undefined)).toBe(true);
    expect(isSpam('카지노 바카라 토토', undefined)).toBe(true);
    expect(isSpam('당첨 경품 확인하세요 https://example.com', undefined)).toBe(true);
    expect(isSpam('내일 점심 어때요', '민수')).toBe(false);
  });
});
