import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ResumeDoc, TalentIntake } from '../../../src/core/contracts/talent.js';
import { BehaviorLlm, FakeFolderScan, FakeKnowledgeWriter, daysAgo, makeFile, makeWalk, profileJson, setupRunner } from './helpers.js';

class RichScan extends FakeFolderScan {
  readonly words = new Map<string, string>();

  async documentText(id: string, maxChars: number): Promise<string | undefined> {
    return this.words.get(id)?.slice(0, maxChars);
  }
}

class FakeIntake implements TalentIntake {
  readonly docs: ResumeDoc[] = [];
  readonly seen = new Set<string>();

  async wants(sourceId: string, modifiedAt: string): Promise<boolean> {
    return !this.seen.has(`${sourceId}|${modifiedAt}`);
  }

  async add(doc: ResumeDoc): Promise<'added'> {
    this.docs.push(doc);
    this.seen.add(`${doc.sourceId}|${doc.modifiedAt}`);
    return 'added';
  }
}

describe('résumés in the first look', () => {
  it('reads PDF and Word files, hands résumés to the talent pack and keeps them out of the profile', async () => {
    const pdf = { ...makeFile('/w/홍길동.pdf', '~/w/홍길동.pdf', 'pdf', daysAgo(1), 50_000), readable: false };
    const docx = { ...makeFile('/w/신사업 기획.docx', '~/w/신사업 기획.docx', 'docx', daysAgo(2), 20_000), readable: false };
    const hwp = { ...makeFile('/w/old.hwp', '~/w/old.hwp', 'hwp', daysAgo(2), 20_000), readable: false };
    const scan = new RichScan(makeWalk([pdf, docx, hwp]));
    scan.words.set('/w/신사업 기획.docx', '# 신사업 기획\n중개 플랫폼');
    const ocr = {
      recognized: [] as string[],
      async recognize(path: string) {
        this.recognized.push(path);
        return { text: '홍길동 이력서 경력 8년 백엔드', pages: 1, method: 'pdf-text' as const };
      },
    };
    const intake = new FakeIntake();
    const writer = new FakeKnowledgeWriter();
    const llm = new BehaviorLlm((request) => {
      const body = request.messages.at(-1)?.content ?? '';
      if (request.purpose === 'onboarding.summarize') return JSON.stringify({ summary: body.includes('이력서') ? '백엔드 개발자 이력서' : '플랫폼 기획', keywords: [], type: body.includes('이력서') ? 'resume' : 'plan' });
      return profileJson({ profile: [{ topic: 'role', key: 'job', text: '인재 소개', sources: ['F1'] }] });
    });
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false },
      capabilities: { [Contracts.ocr.id]: ocr, [Contracts.talentIntake.id]: intake, [Contracts.knowledgeWrite.id]: writer },
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(ocr.recognized).toEqual(['/w/홍길동.pdf']);
    expect(intake.docs.map((doc) => [doc.path, doc.text])).toEqual([['~/w/홍길동.pdf', '홍길동 이력서 경력 8년 백엔드']]);
    // The hwp has no reader here: listed, never sent to the model.
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(2);
    const profile = llm.ofPurpose('onboarding.profile')[0]?.messages.at(-1)?.content ?? '';
    expect(profile).toContain('[plan]');
    expect(profile).not.toContain('홍길동');
    expect(profile).toContain('이력서 1건');

    // A later run with the same files does not hand the résumé over again.
    await setup.runner.run('manual', new AbortController().signal);
    expect(intake.docs).toHaveLength(1);
  });
});

describe('a first look with no AI', () => {
  it('stops without calling itself done, so the next start tries again', async () => {
    const { LlmError } = await import('../../../src/core/llm/types.js');
    const scan = new FakeFolderScan(makeWalk([makeFile('/w/a.md', '~/w/a.md', 'md', daysAgo(1), 10), makeFile('/w/b.md', '~/w/b.md', 'md', daysAgo(1), 10)]));
    scan.bodies.set('/w/a.md', '# 계획');
    scan.bodies.set('/w/b.md', '# 메모');
    const writer = new FakeKnowledgeWriter();
    const llm = new BehaviorLlm(() => {
      throw new LlmError('provider_failed', 'Could not run "claude"');
    });
    const setup = await setupRunner({ llm, scan, config: { drive: false, signals: false }, capabilities: { [Contracts.knowledgeWrite.id]: writer } });
    await setup.runner.run('first', new AbortController().signal);
    expect(setup.state.current.status).toBe('failed');
    expect(setup.state.current.error).toBe('model_unavailable');
    expect(setup.state.current.firstDoneAt).toBeUndefined();
    expect(writer.results).toHaveLength(0);
    expect(setup.progress).toContainEqual({ failed: 'model_unavailable' });
    // one failed call is enough: the rest of the files are not sent
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(1);
  });
});
