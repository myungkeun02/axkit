import { describe, expect, it } from 'vitest';
import { checkSmishing, defang, linkHosts } from '../../../src/skills/sms-reader/smishing.js';

// Made-up messages and hosts only; nothing here is ever opened.
describe('smishing checks', () => {
  it('flags a lookalike courier link with an address lure from a personal number', () => {
    const verdict = checkSmishing('[CJ대한통운] 주소지 불명으로 반송 예정입니다. 주소 확인 http://cj-logis.top/a1', '010-1234-5678');
    expect(verdict.suspicious).toBe(true);
    expect(verdict.reasons).toEqual(expect.arrayContaining(['lookalike', 'odd_domain', 'lure', 'sender_mismatch']));
    expect(verdict.hosts).toEqual(['cj-logis[.]top']);
  });

  it('flags bank lookalikes and misspellings, but not the real domains', () => {
    expect(checkSmishing('[국민은행] 계좌 정지 안내 kbstar-secure.com', undefined).reasons).toContain('lookalike');
    expect(checkSmishing('[국민은행] 안내 https://kbstarr.com/x', undefined).reasons).toContain('lookalike');
    expect(checkSmishing('[국민은행] 이벤트 안내 https://www.kbstar.com/event', '15889999').suspicious).toBe(false);
    expect(checkSmishing('[우체국] 배송 조회 https://service.epost.go.kr/trace', '15881300').suspicious).toBe(false);
  });

  it('flags app-install links, bare IP links and fake approval call-backs', () => {
    expect(checkSmishing('보안 앱 설치 후 확인 바랍니다 https://example.com/update.apk', undefined).reasons).toContain('apk');
    expect(checkSmishing('확인 http://192.0.2.10/login', undefined).reasons).toContain('ip_link');
    expect(checkSmishing('[국외발신] 해외결제 승인 980,000원 본인 아닐 시 010-9876-5432 로 문의', undefined).reasons).toContain('callback');
  });

  it('flags short links with fine or unpaid lures', () => {
    const verdict = checkSmishing('[교통민원24] 과태료 미납 안내 me2.do/xYz12', '+8613012345678');
    expect(verdict.suspicious).toBe(true);
    expect(verdict.reasons).toEqual(expect.arrayContaining(['short_link', 'lure']));
  });

  it('leaves ordinary messages alone', () => {
    expect(checkSmishing('[예시치과] 내일 오후 3시 예약 확인 부탁드립니다. https://example-dental.co.kr', '0212345678').suspicious).toBe(false);
    expect(checkSmishing('[KT] 이용요금 52,300원 납부기한 12월 25일까지', '114').suspicious).toBe(false);
    expect(checkSmishing('엄마 오늘 늦어요', '010-1111-2222').suspicious).toBe(false);
    expect(checkSmishing('과태료 고지서가 발송되었습니다. 경찰청 민원실 02-123-4567', '0212345678').suspicious).toBe(false);
  });

  it('finds hosts without treating numbers as links, and defangs them', () => {
    expect(linkHosts('3.5kg 상품, 가격 1.200원, 사이트 www.example.com/a')).toEqual(['www.example.com']);
    expect(defang('a.b.com')).toBe('a[.]b[.]com');
  });
});
