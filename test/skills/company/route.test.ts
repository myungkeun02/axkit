import { describe, expect, it } from 'vitest';
import { keywordTeam, parseCompanyRequest } from '../../../src/skills/company/route.js';
import { DEV, MARKETING, team } from './helpers.js';

describe('keywordTeam', () => {
  it('lets an explicit @team mention win over scope words', () => {
    const text = '@marketing 개발 버그도 같이 봐 주세요';

    expect(keywordTeam(text, [DEV, MARKETING])?.id).toBe('marketing');
  });

  it('picks the team whose scope words appear most often', () => {
    expect(keywordTeam('버그가 있어요. 개발 쪽 확인 부탁해요', [DEV, MARKETING])?.id).toBe('dev');
    expect(keywordTeam('광고 문구랑 마케팅 자료를 만들어 주세요', [DEV, MARKETING])?.id).toBe('marketing');
  });

  it('matches scope words case-insensitively and in NFC', () => {
    const cafe = team({ id: 'cafe', name: '카페', scope: ['CAFÉ'] });

    expect(keywordTeam('café 메뉴를 정리해 주세요', [cafe])?.id).toBe('cafe');
    expect(keywordTeam('CAFÉ 메뉴', [cafe])?.id).toBe('cafe');
  });

  it('keeps config order on a tie', () => {
    const first = team({ id: 'first', name: '첫째', scope: ['공통'] });
    const second = team({ id: 'second', name: '둘째', scope: ['공통'] });

    expect(keywordTeam('공통 일', [first, second])?.id).toBe('first');
  });

  it('returns undefined when nothing matches', () => {
    expect(keywordTeam('점심 메뉴 추천해 주세요', [DEV, MARKETING])).toBeUndefined();
  });
});

describe('parseCompanyRequest', () => {
  it('accepts colon, space and comma separators', () => {
    expect(parseCompanyRequest('회사: 로그인 고쳐 주세요', '회사')).toBe('로그인 고쳐 주세요');
    expect(parseCompanyRequest('회사 로그인 고쳐 주세요', '회사')).toBe('로그인 고쳐 주세요');
    expect(parseCompanyRequest('회사,로그인 고쳐 주세요', '회사')).toBe('로그인 고쳐 주세요');
    expect(parseCompanyRequest('  회사:   로그인  ', '회사')).toBe('로그인');
  });

  it('rejects the prefix alone, an empty request and unrelated text', () => {
    expect(parseCompanyRequest('회사', '회사')).toBeUndefined();
    expect(parseCompanyRequest('회사:    ', '회사')).toBeUndefined();
    expect(parseCompanyRequest('회사일', '회사')).toBeUndefined();
    expect(parseCompanyRequest('안녕하세요', '회사')).toBeUndefined();
  });
});
