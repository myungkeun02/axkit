import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import type { ToolRunContext } from '../../../src/core/tools/types.js';
import { workTexts } from '../../../src/skills/company/locale-work.js';
import {
  companyDocsTool,
  companyProfileTool,
  onboardingNotice,
  profileQuestions,
} from '../../../src/skills/company/profile.js';
import { ensureTeamDocs } from '../../../src/skills/company/team-docs.js';
import { createTestContext } from '../../support/context.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { MARKETING, NOW } from './helpers.js';
import { DedupeNotifier, RecordingDocStore } from './work-helpers.js';

const runContext: ToolRunContext = {
  log: silentLogger,
  signal: new AbortController().signal,
  call: { grounding: [] },
};

function setupDocs(): { docs: RecordingDocStore; clock: FakeClock } {
  const clock = new FakeClock(NOW);
  return {
    docs: new RecordingDocStore(new KvDocStore(new MapKeyValueStore(), () => clock.now())),
    clock,
  };
}

function deps(docs: RecordingDocStore | undefined) {
  return { docs: () => docs, texts: workTexts('ko') };
}

describe('profileQuestions', () => {
  it('asks three short questions in the owner language', () => {
    expect(profileQuestions('ko')).toHaveLength(3);
    expect(profileQuestions('ko')[0]?.question).toBe('회사를 한두 문장으로 소개해 주세요.');
    expect(profileQuestions('ko')[2]?.question).toContain('외부 발송은 대표 확인 후');
    expect(profileQuestions('en')).toHaveLength(3);
    expect(profileQuestions('en')[1]?.question).toBe('What are the main products or services?');
    expect(profileQuestions('en').map((item) => item.section)).toEqual(['about', 'products', 'policies']);
  });
});

describe('company.profile', () => {
  it('saves the owner words as a company document', async () => {
    const { docs } = setupDocs();
    const tool = companyProfileTool(deps(docs));

    const output = await tool.run(
      { section: 'about', text: '  작은 회사를 합니다.  ', basedOnFacts: ['fact:launch'] },
      runContext,
    );

    expect(tool).toMatchObject({ name: 'company.profile', effects: ['write'] });
    expect(output.message).toBe('회사 문서에 저장했어요: 회사 소개');
    expect(await docs.get('company:about')).toMatchObject({
      kind: 'company',
      scope: 'company',
      title: '회사 소개',
      body: '작은 회사를 합니다.',
      basedOnFacts: ['fact:launch'],
    });
    expect(docs.upserts[0]).toMatchObject({
      id: 'company:about',
      author: { kind: 'agent', id: 'assistant' },
      basedOnFacts: ['fact:launch'],
    });
  });

  it('fails cleanly when the docs capability is missing', async () => {
    const tool = companyProfileTool(deps(undefined));
    await expect(tool.run({ section: 'products', text: '제품' }, runContext)).rejects.toThrow('docs_unavailable');
  });
});

describe('company.docs', () => {
  it('lists company and team documents', async () => {
    const { docs } = setupDocs();
    await ensureTeamDocs(docs, [MARKETING], workTexts('ko'));
    await docs.upsert({
      id: 'company:about',
      kind: 'company',
      scope: 'company',
      title: '회사 소개',
      body: '작은 회사를 합니다.',
      author: { kind: 'user', id: 'owner' },
    });
    const tool = companyDocsTool(deps(docs));

    const output = await tool.run({}, runContext);

    expect(tool.effects).toEqual(['read']);
    expect(output.docs?.map((doc) => doc.id).sort()).toEqual(
      ['company:team:marketing', 'company:about'].sort(),
    );
    expect(output.message).toContain('회사 소개');
    expect(output.message).toContain('마케팅');
  });

  it('renders one document by id and reports a missing one', async () => {
    const { docs } = setupDocs();
    await docs.upsert({
      id: 'company:about',
      kind: 'company',
      scope: 'company',
      title: '회사 소개',
      body: '작은 회사를 합니다.',
      author: { kind: 'user', id: 'owner' },
    });
    const tool = companyDocsTool(deps(docs));

    const rendered = await tool.run({ id: 'company:about' }, runContext);
    expect(rendered.message).toContain('# 회사 소개');
    expect(rendered.message).toContain('작은 회사를 합니다.');

    const missing = await tool.run({ id: 'company:products' }, runContext);
    expect(missing.message).toBe('그 문서를 찾지 못했어요.');
  });

  it('reports no documents yet', async () => {
    const { docs } = setupDocs();
    const tool = companyDocsTool(deps(docs));
    expect((await tool.run({}, runContext)).message).toBe('아직 회사 문서가 없어요.');
  });
});

describe('onboardingNotice', () => {
  function contextWithNotifier(notifier: DedupeNotifier, teams = true): PluginContext {
    const { ctx } = createTestContext({
      now: NOW,
      config: teams
        ? { teams: [{ id: 'marketing', name: '마케팅', role: '마케팅 work', scope: ['마케팅'] }] }
        : {},
      capabilities: { [Contracts.notifier.id]: notifier },
    });
    return ctx;
  }

  it('sends one notice listing the three questions', async () => {
    const { docs } = setupDocs();
    const notifier = new DedupeNotifier();
    const ctx = contextWithNotifier(notifier);

    await onboardingNotice(ctx, docs, workTexts('ko'));
    await onboardingNotice(ctx, docs, workTexts('ko'));

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('company.onboarding');
    expect(notice?.dedupeKey).toBe('profile');
    expect(notice?.text).toContain('회사를 한두 문장으로 소개해 주세요.');
    expect(notice?.text).toContain('답은 그대로 회사 문서가 돼요.');
  });

  it('stays quiet once the owner answered or when there are no teams', async () => {
    const { docs } = setupDocs();
    await docs.upsert({
      id: 'company:about',
      kind: 'company',
      scope: 'company',
      title: '회사 소개',
      body: '작은 회사를 합니다.',
      author: { kind: 'user', id: 'owner' },
    });
    const answered = new DedupeNotifier();
    await onboardingNotice(contextWithNotifier(answered), docs, workTexts('ko'));
    expect(answered.notices).toHaveLength(0);

    const emptyDocs = setupDocs();
    const noTeams = new DedupeNotifier();
    await onboardingNotice(contextWithNotifier(noTeams, false), emptyDocs.docs, workTexts('ko'));
    expect(noTeams.notices).toHaveLength(0);
  });
});
