import type { HandoffReason } from '../../core/contracts/index.js';

const CAPTCHA = /captcha|로봇이 아닙니다|\bi['’]m not a robot\b|verify you are human/i;
// A "로그인" link or "buy" button sits on most pages; only form labels mean the page itself is a login or payment step.
const PAYMENT = /카드\s*번호|결제\s*수단|\bpayment method\b|card number|security code|\bcvc\b/i;
const LOGIN = /비밀번호|로그인\s*(?:후|이 필요|해 주세요|하세요)|\bpassword\b|\b(?:sign|log)[ -]?in to continue\b|\bplease (?:sign|log)[ -]?in\b/i;
const CONSENT = /약관.{0,6}동의|동의하고|\bi agree\b|\baccept (?:the )?terms\b/i;

const LOGIN_PATH = /(^|\/)(login|signin|sign-in)(\/|$)/i;
const PAYMENT_PATH = /(^|\/)(checkout|payment)(\/|$)/i;

function pathOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return '';
  }
}

/**
 * Detects a screen the assistant must not pass. Order is deliberate: captcha first, then payment, login and consent,
 * so a checkout page with a login box still counts as payment.
 */
export function detectHandoff(url: string, text: string): HandoffReason | undefined {
  const path = pathOf(url);
  if (CAPTCHA.test(text)) return 'captcha';
  if (PAYMENT.test(text) || PAYMENT_PATH.test(path)) return 'payment';
  if (LOGIN.test(text) || LOGIN_PATH.test(path)) return 'login';
  if (CONSENT.test(text)) return 'consent';
  return undefined;
}

const CODE_STEP =
  /인증\s*번호|인증\s*코드|확인\s*코드|verification code|one[- ]time (?:code|password)|enter (?:the )?code|\bOTP\b/i;

/** A page that asks for a one-time code (SMS or mail), as opposed to a password or a card. */
export function detectCodeStep(text: string): boolean {
  return CODE_STEP.test(text) && !PAYMENT.test(text) && !CAPTCHA.test(text);
}
