import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { OrgUnit, PersonProfile } from '../../../src/core/contracts/index.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import type { Activity } from '../../../src/skills/onboarding/activity.js';
import type { CachedSummary } from '../../../src/skills/onboarding/cache.js';
import { onboardingTexts } from '../../../src/skills/onboarding/locale.js';
import { cleanMentions } from '../../../src/skills/onboarding/mentions.js';
import { buildOrgMap, codeOrgMap } from '../../../src/skills/onboarding/org-map.js';
import { buildOrg, knownOrgs } from '../../../src/skills/onboarding/org-phase.js';
import { buildRoster } from '../../../src/skills/onboarding/roster.js';
import { createTestContext } from '../../support/context.js';
import { BehaviorLlm } from './helpers.js';

const chart: CachedSummary = {
  stamp: 's',
  kind: 'drive',
  path: 'Drive/2026 조직도',
  title: '2026 조직도',
  modifiedAt: '2026-11-01T00:00:00Z',
  summary: '회사 조직도',
  keywords: [],
  docType: 'orgchart',
  people: [
    { name: '김민수', title: '팀장', unit: '마케팅팀', org: '에이컴퍼니', lead: true },
    { name: '이지은', title: '매니저', unit: '마케팅팀', org: '에이컴퍼니' },
    { name: '박준호', title: '팀장', unit: '개발팀', org: '에이컴퍼니', lead: true },
    { name: '최서연', unit: '개발팀', org: '에이컴퍼니' },
  ],
};

function activity(): Activity {
  return {
    mails: [
      { from: '김민수 <minsu@acompany.co.kr>', subject: '견적', at: '2026-11-20T00:00:00Z', sent: false },
      { from: '김민수 <minsu@acompany.co.kr>', subject: '견적 2', at: '2026-11-21T00:00:00Z', sent: false },
      { from: '나 <me@acompany.co.kr>', subject: '보고', at: '2026-11-21T00:00:00Z', sent: true },
      { from: '광고 <ad@shop.com>', subject: '세일', at: '2026-11-21T00:00:00Z', sent: false },
    ],
    signatures: [{ from: '김민수 <minsu@acompany.co.kr>', text: '김민수 팀장 / 에이컴퍼니 마케팅팀' }],
    recipients: new Map([['이지은 <jieun@acompany.co.kr>', 3]]),
    events: [{ title: '주간 회의', start: '2026-11-23T10:00:00+09:00', allDay: false, attendees: ['minsu@acompany.co.kr', 'jieun@acompany.co.kr'] }],
    ownerEmails: ['me@acompany.co.kr'],
  };
}

describe('mentions', () => {
  it('drops slot words, honorifics, duplicates and things that are not names', () => {
    expect(cleanMentions([{ name: '김민수님', unit: '마케팅팀' }, { name: '김민수' }, { name: '공석' }, { name: 'a@b.com' }, { name: '팀장' }, 'x'])).toEqual([{ name: '김민수', unit: '마케팅팀' }]);
  });
});

describe('roster', () => {
  it('joins document names with mail senders, recipients and attendees, and leaves the owner and one-off senders out', () => {
    const roster = buildRoster([chart], activity());
    const minsu = roster.find((entry) => entry.name === '김민수');
    expect(minsu).toMatchObject({ emails: ['minsu@acompany.co.kr'], docs: 1, mail: 2, meetings: 1, internal: true, signature: '김민수 팀장 / 에이컴퍼니 마케팅팀' });
    expect(minsu?.leads.has('마케팅팀')).toBe(true);
    expect(roster.find((entry) => entry.name === '이지은')).toMatchObject({ mail: 3, meetings: 1, docs: 1 });
    expect(roster.map((entry) => entry.name)).not.toContain('나');
    expect(roster.map((entry) => entry.name)).not.toContain('광고');
  });
});

describe('org map', () => {
  it('builds units from the documents without a model', () => {
    const map = codeOrgMap(buildRoster([chart], undefined), '에이컴퍼니');
    expect(map.units.map((unit) => [unit.name, unit.lead, unit.members])).toEqual([
      ['마케팅팀', '김민수', ['김민수', '이지은']],
      ['개발팀', '박준호', ['박준호', '최서연']],
    ]);
    expect(map.units[1]?.kind).toBe('dev');
  });

  it('keeps only roster people in the units the model returns, with parents', async () => {
    const roster = buildRoster([chart], undefined);
    const llm = new BehaviorLlm(() =>
      JSON.stringify({
        orgs: [{ name: '에이컴퍼니', relation: 'employer' }],
        units: [
          { org: '에이컴퍼니', name: '사업본부', members: [] },
          { org: '에이컴퍼니', name: '마케팅팀', parent: '사업본부', purpose: '브랜드와 광고', lead: 'R1', members: ['R2', 'R99', '홍길동'], roles: [{ title: '광고 리포트', does: '광고 성과를 모아요' }] },
        ],
      }),
    );
    const map = await buildOrgMap({ llm, log: silentLogger, texts: onboardingTexts('ko') }, { roster, summaries: [chart], knownOrgs: ['에이컴퍼니'] });
    expect(map.by).toBe('model');
    const marketing = map.units.find((unit) => unit.name === '마케팅팀');
    expect(marketing).toMatchObject({ parent: '사업본부', lead: roster[0]?.name, purpose: '브랜드와 광고', sources: ['2026 조직도'] });
    expect(marketing?.members).toEqual([roster[0]?.name, roster[1]?.name]);
    expect(map.units.map((unit) => unit.name)).toContain('사업본부');
    expect(map.relations.get('에이컴퍼니')).toBe('employer');
  });
});

describe('buildOrg', () => {
  it('fills person cards and the unit list, and proposes routines with evidence', async () => {
    const cards: { identity: { name?: string; email?: string }; profile: PersonProfile }[] = [];
    let saved: readonly OrgUnit[] = [];
    const writer = {
      noteInteraction: async () => undefined,
      fillFromScan: async (identity: { name?: string; email?: string }, profile: PersonProfile) => {
        cards.push({ identity, profile });
      },
      setUnits: async (units: readonly OrgUnit[]) => {
        saved = units;
      },
    };
    const llm = new BehaviorLlm(() => {
      throw new Error('no model');
    });
    const { ctx } = createTestContext({ llm, capabilities: { [Contracts.peopleWrite.id]: writer } });
    const weekly = Array.from({ length: 5 }, (_, index) => ({ title: '마케팅 주간 회의', start: new Date(Date.parse('2026-11-16T10:00:00+09:00') - index * 7 * 86400000).toISOString(), allDay: false, attendees: [] }));
    const outcome = await buildOrg({
      ctx,
      texts: onboardingTexts('ko'),
      summaries: [chart],
      activity: { ...activity(), events: [...activity().events, ...weekly] },
      result: { profile: [{ area: 'profile', topic: 'org', key: '에이컴퍼니', text: '에이컴퍼니 (다니는 곳): 앱', sources: [], at: '' }], projects: [] },
      now: new Date('2026-11-17T09:00:00+09:00'),
    });
    expect(outcome.units.map((unit) => unit.name)).toEqual(['마케팅팀', '개발팀']);
    expect(saved).toHaveLength(2);
    const minsu = cards.find((card) => card.identity.name === '김민수');
    expect(minsu).toMatchObject({ identity: { email: 'minsu@acompany.co.kr' }, profile: { title: '팀장', company: '에이컴퍼니', team: '마케팅팀', relation: '같은 회사 동료 · 마케팅팀 리드' } });
    expect(minsu?.profile.note).toContain('문서 1개(2026 조직도 등)');
    expect(outcome.lines[0]).toMatchObject({ area: 'people', topic: '에이컴퍼니 조직', key: 'unit:마케팅팀' });
    expect(outcome.routines[0]).toMatchObject({ title: '마케팅 주간 회의 준비', schedule: { kind: 'weekly', day: 'mon', at: '10:00' } });
    expect(outcome.routines[0]?.evidence[0]).toContain("캘린더 '마케팅 주간 회의'");
  });

  it('reads the owner’s own organisations first from the profile', () => {
    const line = (key: string, text: string) => ({ area: 'profile', topic: 'org', key, text, sources: [], at: '' });
    expect(knownOrgs([line('고객사B', '고객사B (고객사): x'), line('에이컴퍼니', '에이컴퍼니 (다니는 곳): y')])).toEqual(['에이컴퍼니', '고객사B']);
  });
});
