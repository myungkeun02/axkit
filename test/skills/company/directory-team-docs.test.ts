import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { companySection } from '../../../src/skills/assistant/company-context.js';
import { syncDirectoryTeamDocs, teamDocId } from '../../../src/skills/company/team-docs.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';

const QA = { id: 'team-qa', name: 'QA', purpose: '밤마다 서비스 4곳을 테스트하고 문제를 알려요', members: [{ name: 'QA 봇', role: '테스트를 나눠 맡겨요' }] };

describe('docs for teams made in chat', () => {
  it('writes a team doc from the team, follows its changes, and leaves an owner-edited doc alone', async () => {
    const clock = new FakeClock(new Date('2026-11-24T11:00:00+09:00'));
    const docs = new KvDocStore(new MapKeyValueStore(), () => clock.now());
    const written = new Map<string, string>();
    await syncDirectoryTeamDocs(docs, [QA], { membersLabel: '구성' }, written);
    expect((await docs.get(teamDocId('team-qa')))?.body).toBe('밤마다 서비스 4곳을 테스트하고 문제를 알려요\n구성:\n- QA 봇: 테스트를 나눠 맡겨요');
    await syncDirectoryTeamDocs(docs, [{ ...QA, members: [...QA.members, { name: 'QA 직원 1', role: '화면을 눌러 봐요' }] }], { membersLabel: '구성' }, written);
    expect((await docs.get(teamDocId('team-qa')))?.body).toContain('QA 직원 1');
    await docs.upsert({ id: teamDocId('team-qa'), kind: 'team', scope: 'team:team-qa', title: 'QA', body: '주인이 고친 글', author: { kind: 'user', id: 'owner' } });
    await syncDirectoryTeamDocs(docs, [QA], { membersLabel: '구성' }, written);
    expect((await docs.get(teamDocId('team-qa')))?.body).toBe('주인이 고친 글');
  });

  it('every room sees the company docs, and a bot also its own team doc', async () => {
    const clock = new FakeClock(new Date('2026-11-24T11:00:00+09:00'));
    const docs = new KvDocStore(new MapKeyValueStore(), () => clock.now());
    await docs.upsert({ id: 'company:policies', kind: 'company', scope: 'company', title: '회사 규칙', body: '매 태스크마다 board.betalab.kr에 기입', author: { kind: 'user', id: 'owner' } });
    await syncDirectoryTeamDocs(docs, [QA], { membersLabel: '구성' }, new Map());
    const context = createTestContext({ capabilities: { [Contracts.docs.id]: docs } });
    const main = await companySection(context.ctx, true);
    expect(main).toContain('매 태스크마다 board.betalab.kr에 기입');
    expect(main).not.toContain('QA 봇');
    expect(await companySection(context.ctx, true, 'team-qa')).toContain('QA 봇: 테스트를 나눠 맡겨요');
  });
});
