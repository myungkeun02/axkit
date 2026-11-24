import { describe, expect, it } from 'vitest';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { workTexts } from '../../../src/skills/company/locale-work.js';
import {
  ensureTeamDocs,
  logChange,
  logDecision,
  teamContext,
  teamDocId,
} from '../../../src/skills/company/team-docs.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { MARKETING } from './helpers.js';
import { DEV_TEAM, RecordingDocStore } from './work-helpers.js';

function setup(): { docs: RecordingDocStore; clock: FakeClock; texts: ReturnType<typeof workTexts> } {
  const clock = new FakeClock(new Date('2026-11-18T09:00:00+09:00'));
  const docs = new RecordingDocStore(new KvDocStore(new MapKeyValueStore(), () => clock.now()));
  return { docs, clock, texts: workTexts('ko') };
}

describe('ensureTeamDocs', () => {
  it('creates the team, decision and changelog docs once and never overwrites the owner', async () => {
    const { docs, texts } = setup();

    await ensureTeamDocs(docs, [MARKETING], texts);

    const team = await docs.get('company:team:marketing');
    expect(team).toMatchObject({
      kind: 'team',
      scope: 'team:marketing',
      title: '마케팅',
      body: '마케팅 work\n맡는 일: 마케팅, 광고',
    });
    expect(docs.upserts.find((input) => input.id === 'company:team:marketing')?.author).toEqual({
      kind: 'policy',
      id: 'config',
    });
    expect(await docs.get('company:decisions:marketing')).toMatchObject({ kind: 'decision' });
    expect(await docs.get('company:changelog:marketing')).toMatchObject({ kind: 'changelog' });

    await docs.upsert({
      id: teamDocId('marketing'),
      kind: 'team',
      scope: 'team:marketing',
      title: '마케팅',
      body: '대표가 직접 고친 내용',
      author: { kind: 'user', id: 'owner' },
    });
    await ensureTeamDocs(docs, [MARKETING], texts);

    expect((await docs.get('company:team:marketing'))?.body).toBe('대표가 직접 고친 내용');
  });
});

describe('teamContext', () => {
  it('includes the team doc, company profile docs and the five newest decisions', async () => {
    const { docs, clock, texts } = setup();
    await ensureTeamDocs(docs, [MARKETING], texts);
    await docs.upsert({
      id: 'company:about',
      kind: 'company',
      scope: 'company',
      title: '회사 소개',
      body: '작은 회사를 합니다.',
      author: { kind: 'user', id: 'owner' },
    });
    for (let index = 0; index < 6; index += 1) {
      await logDecision(docs, 'marketing', `결정 ${index}`, { kind: 'agent', id: 'lead:marketing' }, []);
      await clock.advance(1000);
    }

    const context = await teamContext(docs, 'marketing');

    expect(context).toContain('마케팅 work');
    expect(context).toContain('작은 회사를 합니다.');
    expect(context).toContain('결정 5');
    expect(context).toContain('결정 1');
    expect(context).not.toContain('결정 0');
  });

  it('marks documents that need review and clips the context to 3000 characters', async () => {
    const { docs, texts } = setup();
    await ensureTeamDocs(docs, [MARKETING], texts);
    await docs.upsert({
      id: 'company:about',
      kind: 'company',
      scope: 'company',
      title: '회사 소개',
      body: '가'.repeat(5000),
      author: { kind: 'user', id: 'owner' },
      basedOnFacts: ['fact:launch'],
    });
    await docs.flagFact('fact:launch', '사실 만료');

    const context = await teamContext(docs, 'marketing');

    expect(context).toHaveLength(3000);
    expect(context).toContain('(needs review)');
  });

  it('returns only the team doc when there is no company profile', async () => {
    const { docs, texts } = setup();
    await ensureTeamDocs(docs, [DEV_TEAM], texts);
    const context = await teamContext(docs, 'dev');
    expect(context).toContain('개발 work');
    expect(context).not.toContain('company:');
  });
});

describe('logDecision/logChange', () => {
  it('appends dated entries with the author and sources', async () => {
    const { docs, clock, texts } = setup();
    await ensureTeamDocs(docs, [MARKETING], texts);
    await clock.advance(1000);

    await logDecision(docs, 'marketing', '계획 승인', { kind: 'agent', id: 'lead:marketing' }, ['task:abcd1234']);
    await logChange(docs, 'marketing', '문구 작성: 첫 줄', { kind: 'agent', id: 'member:marketing' }, ['task:abcd1234']);

    const decisions = await docs.get('company:decisions:marketing');
    expect(decisions?.entries).toHaveLength(1);
    expect(decisions?.entries[0]).toMatchObject({
      text: '계획 승인',
      author: { kind: 'agent', id: 'lead:marketing' },
      sources: ['task:abcd1234'],
    });
    const changelog = await docs.get('company:changelog:marketing');
    expect(changelog?.entries[0]?.text).toBe('문구 작성: 첫 줄');
  });

  it('does nothing when the team document was never created', async () => {
    const { docs } = setup();
    await logDecision(docs, 'marketing', '결정', { kind: 'agent', id: 'lead:marketing' }, []);
    expect(await docs.get('company:decisions:marketing')).toBeUndefined();
  });
});
