import { describe, expect, it } from 'vitest';
import { detectHandoff } from '../../../src/connectors/browser/handoff.js';

describe('detectHandoff', () => {
  it.each([
    ['로그인 후 이용해 주세요', 'login'],
    ['비밀번호를 입력하세요', 'login'],
    ['Sign in to continue', 'login'],
    ['Please log in', 'login'],
    ['카드번호를 입력하세요', 'payment'],
    ['결제 수단을 선택하세요', 'payment'],
    ['Payment method', 'payment'],
    ['Card number', 'payment'],
    ['약관에 동의해 주세요', 'consent'],
    ['동의하고 계속', 'consent'],
    ['I agree', 'consent'],
    ['Accept the terms', 'consent'],
    ['captcha', 'captcha'],
    ['로봇이 아닙니다', 'captcha'],
    ["I'm not a robot", 'captcha'],
    ['Verify you are human', 'captcha'],
  ])('detects %s as %s', (text, reason) => {
    expect(detectHandoff('https://example.com/', text)).toBe(reason);
  });

  it.each([
    ['https://example.com/login', 'login'],
    ['https://example.com/account/signin', 'login'],
    ['https://example.com/checkout', 'payment'],
    ['https://example.com/payment/step2', 'payment'],
  ])('detects a %s path', (url, reason) => {
    expect(detectHandoff(url, 'nothing here')).toBe(reason);
  });

  it('keeps the priority order captcha > payment > login > consent', () => {
    expect(detectHandoff('https://example.com/', 'captcha 카드번호 비밀번호 동의하고')).toBe('captcha');
    expect(detectHandoff('https://example.com/', '카드번호 비밀번호 동의하고')).toBe('payment');
    expect(detectHandoff('https://example.com/', '비밀번호 동의하고')).toBe('login');
  });

  it('ignores the login link and buy button that sit on ordinary pages', () => {
    expect(detectHandoff('https://example.com/item/1', '로그인 | 회원가입\n상품 설명\n결제하기 장바구니')).toBeUndefined();
    expect(detectHandoff('https://example.com/item/1', 'Sign in  Cart  Checkout  Product details')).toBeUndefined();
  });

  it('lets payment text win over a login path', () => {
    expect(detectHandoff('https://example.com/login', '카드번호')).toBe('payment');
  });

  it('returns undefined for an ordinary page', () => {
    expect(detectHandoff('https://example.com/about', '회사 소개')).toBeUndefined();
  });

  it('ignores an unparseable URL', () => {
    expect(detectHandoff('not a url', 'hello')).toBeUndefined();
  });
});
