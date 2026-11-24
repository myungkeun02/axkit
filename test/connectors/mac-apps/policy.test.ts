import { describe, expect, it } from 'vitest';
import { actRefusal, categorize, effectsOfLabel, secureFieldRefusal } from '../../../src/connectors/mac-apps/policy.js';
import { parseStep, renderNodes } from '../../../src/connectors/mac-apps/resolve.js';

describe('app categories', () => {
  it.each([
    [{ name: 'KB스타뱅킹', bundle: 'com.kbstar.kbbank' }, 'money'],
    [{ name: '토스', bundle: 'com.vivarepublica.toss' }, 'money'],
    [{ name: '카카오뱅크', bundle: 'com.kakaobank.channel' }, 'money'],
    [{ name: 'PayPal', bundle: 'com.example.unknown' }, 'money'],
    [{ name: '키움증권 영웅문', bundle: 'com.kiwoom.hero' }, 'money'],
    [{ name: 'MetaMask', bundle: 'io.metamask' }, 'money'],
    [{ name: '1Password 7', bundle: 'com.agilebits.onepassword7' }, 'secret'],
    [{ name: '키체인 접근', bundle: 'com.apple.keychainaccess' }, 'secret'],
    [{ name: 'Passwords', bundle: 'com.apple.Passwords' }, 'secret'],
    [{ name: 'Bitwarden', bundle: 'com.bitwarden.desktop' }, 'secret'],
    [{ name: '터미널', bundle: 'com.apple.Terminal' }, 'shell'],
    [{ name: 'iTerm2', bundle: 'com.googlecode.iterm2' }, 'shell'],
    [{ name: '시스템 설정', bundle: 'com.apple.systempreferences' }, 'system'],
    [{ name: '메모', bundle: 'com.apple.Notes' }, 'normal'],
    [{ name: 'Safari', bundle: 'com.apple.Safari' }, 'normal'],
  ] as const)('%o is %s', (app, category) => {
    expect(categorize(app)).toBe(category);
  });

  it('judges a bare name the model gave the same way', () => {
    expect(categorize({ name: '토스', bundle: '토스' })).toBe('money');
    expect(categorize({ name: 'com.agilebits.onepassword7', bundle: 'com.agilebits.onepassword7' })).toBe('secret');
  });

  it('refuses to act in money and secret apps only', () => {
    expect(actRefusal('money')).toContain('읽기만');
    expect(actRefusal('secret')).toContain('읽기만');
    expect(actRefusal('shell')).toBeUndefined();
    expect(actRefusal('normal')).toBeUndefined();
  });
});

describe('field and label rules', () => {
  it('never types into password fields or fields that look like one', () => {
    expect(secureFieldRefusal('AXSecureTextField', undefined)).toContain('비밀번호 칸');
    expect(secureFieldRefusal('AXTextField', '비밀번호')).toBeDefined();
    expect(secureFieldRefusal('AXTextField', '인증번호 6자리')).toBeDefined();
    expect(secureFieldRefusal('AXTextField', 'Card number')).toBeDefined();
    expect(secureFieldRefusal('AXTextField', '제목')).toBeUndefined();
  });

  it('adds send, delete and pay effects from the label', () => {
    expect(effectsOfLabel('저장')).toEqual(['write']);
    expect(effectsOfLabel('보내기')).toEqual(['write', 'send']);
    expect(effectsOfLabel('Move to Trash')).toEqual(['write', 'delete']);
    expect(effectsOfLabel('결제하기')).toEqual(['write', 'pay']);
  });

  it('parses steps and renders nodes', () => {
    expect(parseStep('AXButton[보내기]')).toEqual({ role: 'AXButton', title: '보내기' });
    expect(parseStep('AXSheet')).toEqual({ role: 'AXSheet' });
    expect(parseStep('button')).toBeUndefined();
    const text = renderNodes([
      { depth: 0, role: 'AXWindow', subrole: '', label: '메일', value: '', secure: false, disabled: false, focused: false },
      { depth: 1, role: 'AXSecureTextField', subrole: '', label: '암호', value: '', secure: true, disabled: false, focused: true },
      { depth: 1, role: 'AXTextField', subrole: '', label: '제목', value: '안녕', secure: false, disabled: true, focused: false },
    ]);
    expect(text).toBe('AXWindow[메일]\n  AXSecureTextField[암호] (password field, focused)\n  AXTextField[제목] = "안녕" (disabled)');
  });
});
