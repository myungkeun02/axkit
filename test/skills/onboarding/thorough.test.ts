import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { FileEntry, FileSource, FileSourceRegistry, OrgUnit, PersonProfile, ScanResult } from '../../../src/core/contracts/index.js';
import { BehaviorLlm, FakeKnowledgeWriter, daysAgo, makeFile, makeWalk, profileJson, setupRunner, summaryJson } from './helpers.js';
import { FakeFolderScan } from './helpers.js';

class PagedDrive implements FileSource {
  readonly bodies = new Map<string, string>();
  readonly pages: string[] = [];
  constructor(readonly label: string, private readonly entries: FileEntry[][]) {}
  async list(): Promise<FileEntry[]> {
    return [];
  }
  async readText(id: string): Promise<string> {
    return this.bodies.get(id) ?? '';
  }
  async everything(opts: { pageToken?: string }): Promise<{ entries: FileEntry[]; next?: string }> {
    const index = opts.pageToken === undefined ? 0 : Number(opts.pageToken);
    this.pages.push(String(index));
    return { entries: this.entries[index] ?? [], ...(index + 1 < this.entries.length ? { next: String(index + 1) } : {}) };
  }
}

const doc = (id: string, name: string, days: number): FileEntry => ({ id, name, path: `Drive/${name}`, mimeType: 'application/vnd.google-apps.document', size: 10, modifiedAt: daysAgo(days) });

describe('a thorough first look', () => {
  it('reads every page of every connected Drive once, and turns the org chart into people and teams', async () => {
    const main = new PagedDrive('drive', [[doc('d1', '2026 조직도', 1)], [doc('d2', '회의록', 2)]]);
    const other = new PagedDrive('drive:a2', [[doc('d2', '회의록', 2), doc('d3', '제안서', 3)]]);
    main.bodies.set('d1', '마케팅팀 김민수 팀장, 이지은 매니저 / 개발팀 박준호 팀장, 최서연');
    main.bodies.set('d2', '회의');
    other.bodies.set('d3', '제안');
    const registry: FileSourceRegistry = { register: () => undefined, list: () => [main, other] };
    const cards: { name?: string; profile: PersonProfile }[] = [];
    let units: readonly OrgUnit[] = [];
    const people = {
      noteInteraction: async () => undefined,
      fillFromScan: async (identity: { name?: string }, profile: PersonProfile) => void cards.push({ ...identity, profile }),
      setUnits: async (found: readonly OrgUnit[]) => void (units = found),
    };
    const writer = new FakeKnowledgeWriter();
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') {
        const text = request.messages.at(-1)?.content ?? '';
        if (!text.includes('김민수')) return summaryJson('문서');
        return JSON.stringify({
          summary: '회사 조직도',
          keywords: ['조직'],
          type: 'orgchart',
          people: [
            { name: '김민수', title: '팀장', unit: '마케팅팀', org: '에이컴퍼니', lead: true },
            { name: '이지은', title: '매니저', unit: '마케팅팀', org: '에이컴퍼니' },
            { name: '박준호', title: '팀장', unit: '개발팀', org: '에이컴퍼니', lead: true },
            { name: '최서연', unit: '개발팀', org: '에이컴퍼니' },
          ],
        });
      }
      if (request.purpose === 'onboarding.profile') return profileJson({ profile: [{ topic: 'org', key: '에이컴퍼니', text: '에이컴퍼니 (다니는 곳)', sources: ['F1'] }] });
      throw new Error('no model for this step');
    });
    const setup = await setupRunner({
      llm,
      scan: new FakeFolderScan(makeWalk()),
      config: { signals: false },
      capabilities: {
        [Contracts.filesDrive.id]: main,
        [Contracts.fileSources.id]: registry,
        [Contracts.peopleWrite.id]: people,
        [Contracts.knowledgeWrite.id]: writer,
      },
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(setup.state.current.status).toBe('done');
    expect(main.pages).toEqual(['0', '1']);
    expect(setup.state.current.counts.drive).toBe(3);
    expect(llm.ofPurpose('onboarding.summarize')).toHaveLength(3);
    expect(units.map((unit) => [unit.name, unit.lead, unit.members])).toEqual([
      ['마케팅팀', '김민수', ['김민수', '이지은']],
      ['개발팀', '박준호', ['박준호', '최서연']],
    ]);
    expect(cards.find((card) => card.name === '김민수')?.profile).toMatchObject({ title: '팀장', team: '마케팅팀', company: '에이컴퍼니' });
    const result: ScanResult | undefined = writer.results[0];
    expect(result?.units?.map((unit) => unit.name)).toEqual(['마케팅팀', '개발팀']);
    expect(result?.profile.some((line) => line.area === 'people' && line.key === 'unit:마케팅팀')).toBe(true);
    const finished = setup.progress.find((event) => 'finished' in event);
    expect(finished).toMatchObject({ finished: { found: { people: 4, units: 2 } } });
  });

  it('keeps every local document, counting spreadsheets by name, and leaves what is over budget for the next run', async () => {
    const files = [makeFile('/w/a.md', '~/w/a.md', 'md', daysAgo(1)), makeFile('/w/b.md', '~/w/b.md', 'md', daysAgo(2)), makeFile('/w/결산.xlsx', '~/w/결산.xlsx', 'xlsx', daysAgo(3), 100, false)];
    const scan = new FakeFolderScan(makeWalk(files));
    scan.bodies.set('/w/a.md', 'a');
    scan.bodies.set('/w/b.md', 'b');
    const llm = new BehaviorLlm((request) => (request.purpose === 'onboarding.summarize' ? summaryJson('요약') : profileJson({})));
    const setup = await setupRunner({ llm, scan, config: { drive: false, signals: false, depth: 'quick', maxSummariesPerRun: 1 } });
    await setup.runner.run('first', new AbortController().signal);
    expect(setup.state.current.counts.files).toBe(3);
    expect(setup.state.current.pending).toBe(1);
  });
});
