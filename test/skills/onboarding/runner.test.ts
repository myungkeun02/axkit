import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { KnowledgeLine } from '../../../src/core/contracts/index.js';
import { LlmError } from '../../../src/core/llm/types.js';
import {
  BehaviorLlm,
  FakeDrive,
  FakeFolderScan,
  FakeKnowledgeWriter,
  FakeOwnerReview,
  FakeProfile,
  NOW,
  daysAgo,
  makeFile,
  makeRepo,
  makeWalk,
  profileJson,
  setupRunner,
  summaryJson,
} from './helpers.js';

function capabilitiesOf(options: {
  writer?: FakeKnowledgeWriter;
  profile?: FakeProfile;
  review?: FakeOwnerReview;
}): Record<string, unknown> {
  return {
    ...(options.writer !== undefined ? { [Contracts.knowledgeWrite.id]: options.writer } : {}),
    ...(options.profile !== undefined ? { [Contracts.knowledgeProfile.id]: options.profile } : {}),
    ...(options.review !== undefined ? { [Contracts.ownerReview.id]: options.review } : {}),
  };
}

function withSources(lines: readonly KnowledgeLine[]): boolean {
  return lines.every((line) => line.sources.length > 0);
}

describe('OnboardingRunner first run', () => {
  it('scans folders, Drive and signals, writes grounded lines and starts one review', async () => {
    const scan = new FakeFolderScan(
      makeWalk([makeFile('/work/notes.md', '~/work/notes.md', 'md', daysAgo(2), 10)], [
        makeRepo('/work/repo', '~/work/repo', daysAgo(3)),
      ]),
    );
    scan.bodies.set('/work/notes.md', '# 회의록\n연락처 kim@example.com');
    scan.repos.set('/work/repo', {
      readme: '# Ax kit\n개인 비서',
      commits: [{ at: daysAgo(4), subject: '초기 커밋' }],
      languages: [{ ext: 'ts', files: 10 }],
    });

    const drive = new FakeDrive([
      {
        id: 'd1',
        name: '기획서',
        path: 'Drive/기획서',
        mimeType: 'application/vnd.google-apps.document',
        size: 100,
        modifiedAt: daysAgo(1),
      },
    ]);
    drive.bodies.set('d1', '기획서 내용');

    const writer = new FakeKnowledgeWriter();
    const profile = new FakeProfile([{ id: 'line-role', text: '개발자예요' }]);
    const review = new FakeOwnerReview();
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') return summaryJson('한 줄 요약', ['ts']);
      return profileJson({
        profile: [
          { topic: 'role', key: 'job', text: '개발자예요', sources: ['F1'] },
          { topic: 'other', key: 'contacts', text: '사람들과 일해요', sources: ['M1'] },
        ],
        projects: [
          { name: 'ax-kit', purpose: '개인 비서', status: '진행 중', recent: '초기 커밋', sources: ['F1', 'F3'] },
        ],
      });
    });

    const setup = await setupRunner({
      llm,
      scan,
      drive,
      collector: {
        id: 'fake-mail',
        async collect() {
          return [{ source: 'mail', text: '보낸 사람: Kim (2)' }];
        },
      },
      capabilities: capabilitiesOf({ writer, profile, review }),
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(setup.state.current.status).toBe('done');
    expect(setup.state.current.firstDoneAt).toBeDefined();
    expect(setup.state.current.reviewSentAt).toBeDefined();
    expect(setup.state.current.counts).toEqual({ files: 1, repos: 1, drive: 1, summarized: 3, signals: 1, docs: 0, sessions: 0 });
    expect(setup.cache.size).toBe(3);

    const result = writer.results[0];
    expect(result).toBeDefined();
    expect(withSources(result?.profile ?? [])).toBe(true);
    expect(withSources(result?.projects ?? [])).toBe(true);
    const filesLine = result?.projects.find((line) => line.key === 'files');
    expect(filesLine?.text).toBe('~/work/repo, ~/work/notes.md');
    expect(result?.profile.map((line) => line.key)).toEqual(['job', 'contacts']);

    expect(review.requests).toHaveLength(1);
    expect(review.requests[0]).toMatchObject({ id: 'knowledge.profile', title: '제가 이해한 당신' });
    expect(review.requests[0]?.items).toEqual([{ id: 'line-role', text: '개발자예요' }]);

    const summarizes = llm.ofPurpose('onboarding.summarize');
    expect(summarizes).toHaveLength(3);
    expect(summarizes.every((request) => request.sensitivity === 'masked')).toBe(true);
    const profiles = llm.ofPurpose('onboarding.profile');
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.sensitivity).toBe('sensitive');

    const notesRequest = summarizes.find((request) =>
      request.messages.some((message) => message.content.includes('회의록')),
    );
    const notesText = notesRequest?.messages.map((message) => message.content).join('\n') ?? '';
    expect(notesText).toContain('[email]');
    expect(notesText).not.toContain('kim@example.com');

    expect(setup.progress.some((event) => 'finished' in event)).toBe(true);
  });
});

describe('incremental runs', () => {
  it('summarizes only items whose stamp changed and starts the review only once', async () => {
    const notes = makeFile('/work/notes.md', '~/work/notes.md', 'md', daysAgo(2), 10);
    const scan = new FakeFolderScan(makeWalk([notes], [makeRepo('/work/repo', '~/work/repo', daysAgo(3))]));
    scan.bodies.set('/work/notes.md', '회의록 내용');
    scan.repos.set('/work/repo', { readme: '프로젝트', commits: [], languages: [{ ext: 'ts', files: 1 }] });

    const writer = new FakeKnowledgeWriter();
    const review = new FakeOwnerReview();
    const profile = new FakeProfile([{ id: 'line-one', text: '한 줄' }]);
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') return summaryJson('요약', ['ts']);
      return profileJson({ profile: [{ topic: 'other', key: 'x', text: 'x', sources: ['F1'] }] });
    });
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false },
      capabilities: capabilitiesOf({ writer, profile, review }),
    });

    await setup.runner.run('first', new AbortController().signal);
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(2);

    await setup.runner.run('daily', new AbortController().signal);
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(2);
    // Nothing changed, so the daily run spends no profile call.
    expect(llm.ofPurpose('onboarding.profile')).toHaveLength(1);
    expect(review.requests).toHaveLength(1);

    scan.walkData = makeWalk([makeFile('/work/notes.md', '~/work/notes.md', 'md', daysAgo(0), 11)], [
      makeRepo('/work/repo', '~/work/repo', daysAgo(3)),
    ]);
    await setup.runner.run('daily', new AbortController().signal);

    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(3);
    expect(llm.ofPurpose('onboarding.profile')).toHaveLength(2);
    expect(review.requests).toHaveLength(1);
  });

  it('keeps a model-written profile when a later run only has the code fallback', async () => {
    const scan = new FakeFolderScan(makeWalk([], [makeRepo('/work/repo', '~/work/repo', daysAgo(3))]));
    scan.repos.set('/work/repo', { readme: '프로젝트', commits: [], languages: [{ ext: 'ts', files: 1 }] });
    const writer = new FakeKnowledgeWriter();
    let modelUp = true;
    const llm = new BehaviorLlm((request) => {
      if (!modelUp) throw new LlmError('over_budget', 'over budget');
      if (request.purpose === 'onboarding.summarize') return summaryJson('요약', ['ts']);
      return profileJson({ profile: [{ topic: 'role', key: 'job', text: '개발자', sources: ['F1'] }] });
    });
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false },
      capabilities: capabilitiesOf({ writer }),
    });

    await setup.runner.run('first', new AbortController().signal);
    expect(writer.results).toHaveLength(1);

    modelUp = false;
    scan.walkData = makeWalk([], [makeRepo('/work/repo', '~/work/repo', daysAgo(0))]);
    await setup.runner.run('daily', new AbortController().signal);

    expect(writer.results).toHaveLength(1);
  });

  it('reads a document again on the next run when its read failed', async () => {
    const notes = makeFile('/work/notes.md', '~/work/notes.md', 'md', daysAgo(2), 10);
    const scan = new FakeFolderScan(makeWalk([notes], []));
    scan.bodies.set('/work/notes.md', '회의록 내용');
    let failRead = true;
    const excerpt = scan.excerpt.bind(scan);
    scan.excerpt = async (id: string, maxBytes: number): Promise<string> => {
      if (failRead) throw new Error('EACCES');
      return await excerpt(id, maxBytes);
    };
    const llm = new BehaviorLlm((request) =>
      request.purpose === 'onboarding.summarize' ? summaryJson('요약', ['md']) : profileJson({}),
    );
    const setup = await setupRunner({ llm, scan, config: { drive: false, signals: false } });

    await setup.runner.run('first', new AbortController().signal);
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(0);
    failRead = false;
    await setup.runner.run('daily', new AbortController().signal);
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(1);
    await setup.runner.run('daily', new AbortController().signal);
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(1);
  });

  it('caps model summaries per run and finishes them on a later run', async () => {
    const walk = makeWalk([
      makeFile('/work/a.md', '~/work/a.md', 'md', daysAgo(1), 1),
      makeFile('/work/b.md', '~/work/b.md', 'md', daysAgo(2), 1),
      makeFile('/work/c.md', '~/work/c.md', 'md', daysAgo(3), 1),
    ]);
    const scan = new FakeFolderScan(walk);
    scan.bodies.set('/work/a.md', 'a');
    scan.bodies.set('/work/b.md', 'b');
    scan.bodies.set('/work/c.md', 'c');
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') return summaryJson('요약');
      return profileJson({ profile: [{ topic: 'other', key: 'x', text: 'x', sources: ['F1'] }] });
    });
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false, maxSummariesPerRun: 1, depth: 'quick' },
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(1);
    expect(setup.cache.size).toBe(3);
    expect(setup.state.current.counts.summarized).toBe(1);

    setup.config.maxSummariesPerRun = 2;
    await setup.runner.run('daily', new AbortController().signal);

    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(3);
    expect(setup.state.current.counts.summarized).toBe(2);
  });
});

describe('model failures', () => {
  it('stops calling the model after no_route and falls back to repo summaries', async () => {
    const scan = new FakeFolderScan(
      makeWalk([
        makeFile('/work/a.md', '~/work/a.md', 'md', daysAgo(1), 1),
        makeFile('/work/b.md', '~/work/b.md', 'md', daysAgo(2), 1),
      ], [makeRepo('/work/repo', '~/work/repo', daysAgo(1))]),
    );
    scan.bodies.set('/work/a.md', 'a 문서');
    scan.bodies.set('/work/b.md', 'b 문서');
    scan.repos.set('/work/repo', { readme: 'README', commits: [], languages: [{ ext: 'ts', files: 1 }] });
    let summarizeCalls = 0;
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') {
        summarizeCalls += 1;
        if (summarizeCalls >= 2) throw new LlmError('no_route', 'down');
        return summaryJson('개인 비서 프로젝트', ['ts', '2026-11-10']);
      }
      throw new LlmError('no_route', 'down');
    });
    const writer = new FakeKnowledgeWriter();
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false },
      capabilities: capabilitiesOf({ writer }),
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(setup.state.current.status).toBe('done');
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(2);
    expect(llm.ofPurpose('onboarding.profile')).toHaveLength(1);
    const projects = writer.results[0]?.projects ?? [];
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: 'project', topic: 'repo', key: 'purpose', text: '개인 비서 프로젝트' }),
        expect.objectContaining({ area: 'project', topic: 'repo', key: 'status', text: '진행 중' }),
        expect.objectContaining({ area: 'project', topic: 'repo', key: 'files', text: '~/work/repo' }),
      ]),
    );
    expect(projects.every((line) => line.sources.length > 0)).toBe(true);
  });

  it('drops model lines without a valid source id', async () => {
    const scan = new FakeFolderScan(makeWalk([makeFile('/work/a.md', '~/work/a.md', 'md', daysAgo(1), 1)]));
    scan.bodies.set('/work/a.md', '문서');
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') return summaryJson('요약');
      return profileJson({
        profile: [
          { topic: 'role', key: 'job', text: '개발자', sources: ['F1'] },
          { topic: 'role', key: 'fake', text: '의사', sources: ['F99'] },
          { topic: 'role', key: 'empty', text: '', sources: ['F1'] },
        ],
        projects: [
          { name: '가짜', purpose: 'x', sources: ['X1'] },
          { name: '진짜', purpose: 'y', sources: ['S1'] },
        ],
      });
    });
    const writer = new FakeKnowledgeWriter();
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false },
      capabilities: capabilitiesOf({ writer }),
    });

    await setup.runner.run('first', new AbortController().signal);

    const result = writer.results[0];
    expect(result?.profile.map((line) => line.key)).toEqual(['job']);
    expect(result?.projects).toEqual([
      expect.objectContaining({ topic: '진짜', key: 'purpose', text: 'y', sources: ['folders'] }),
    ]);
  });
});

describe('stop and resume', () => {
  it('pauses on abort and resumes from the cache without summarizing again', async () => {
    const scan = new FakeFolderScan(
      makeWalk([
        makeFile('/work/a.md', '~/work/a.md', 'md', daysAgo(1), 1),
        makeFile('/work/b.md', '~/work/b.md', 'md', daysAgo(2), 1),
      ]),
    );
    scan.bodies.set('/work/a.md', 'a');
    scan.bodies.set('/work/b.md', 'b');
    let controller = new AbortController();
    let summarizeCalls = 0;
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') {
        summarizeCalls += 1;
        if (summarizeCalls === 2) controller.abort();
        return summaryJson('요약');
      }
      return profileJson({ profile: [{ topic: 'other', key: 'x', text: 'x', sources: ['F1'] }] });
    });
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false },
    });

    await setup.runner.run('manual', controller.signal);

    expect(setup.state.current.status).toBe('paused');
    expect(setup.cache.size).toBe(2);

    controller = new AbortController();
    await setup.runner.run('manual', controller.signal);

    expect(setup.state.current.status).toBe('done');
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(2);
    expect(llm.ofPurpose('onboarding.profile')).toHaveLength(1);
  });
});

describe('signals', () => {
  it('skips a failing collector and keeps the others', async () => {
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') return summaryJson('요약');
      return profileJson({ profile: [{ topic: 'other', key: 'flow', text: '메일이 많아요', sources: ['M1'] }] });
    });
    const writer = new FakeKnowledgeWriter();
    const setup = await setupRunner({
      llm,
      walk: makeWalk(),
      config: { drive: false },
      collectors: [
        {
          id: 'broken',
          async collect() {
            throw new Error('boom');
          },
        },
        {
          id: 'good',
          async collect() {
            return [{ source: 'mail', text: '보낸 사람: Kim (2)' }];
          },
        },
      ],
      capabilities: capabilitiesOf({ writer }),
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(setup.state.current.status).toBe('done');
    expect(setup.state.current.counts.signals).toBe(1);
    expect(writer.results[0]?.profile).toEqual([
      expect.objectContaining({ key: 'flow', sources: ['mail'] }),
    ]);
    const prompt = llm.ofPurpose('onboarding.profile')[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('보낸 사람: Kim (2)');
  });
});

describe('time', () => {
  it('uses the injected clock for run timestamps', async () => {
    const setup = await setupRunner({
      llm: new BehaviorLlm(() => profileJson({})),
      walk: makeWalk(),
      config: { drive: false, signals: false },
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(setup.state.current.startedAt).toBe(NOW.toISOString());
    expect(setup.state.current.finishedAt).toBe(NOW.toISOString());
  });
});
