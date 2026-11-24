import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { KnowledgeBuilder } from '../../../src/skills/knowledge/builder.js';
import { knowledgeTexts } from '../../../src/skills/knowledge/locale.js';
import { KnowledgeStore } from '../../../src/skills/knowledge/store.js';
import { DocWriter } from '../../../src/skills/knowledge/writer.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { line, MemoryDocFs } from './helpers.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const DAY = 86_400_000;

async function setup(withWriter = true) {
  const kv = new MapKeyValueStore();
  const store = new KnowledgeStore(kv);
  await store.load();
  const fs = new MemoryDocFs();
  const clock = new FakeClock(NOW);
  const writer = withWriter ? new DocWriter('/kb', fs) : undefined;
  const builder = new KnowledgeBuilder({
    store,
    kv,
    writer,
    texts: knowledgeTexts('ko'),
    clock,
    timeZone: 'Asia/Seoul',
    log: silentLogger,
  });
  return { kv, store, fs, clock, builder };
}

async function seed(store: KnowledgeStore): Promise<void> {
  await store.replaceOrigin('scan', [
    line({
      area: 'profile',
      topic: 'role',
      key: 'role',
      text: '엔지니어',
      sources: ['scan:~/Documents/profile.md'],
      at: '2026-11-01T09:00:00+09:00',
    }),
    line({
      area: 'project',
      topic: 'Acme',
      key: 'purpose',
      text: '결제 앱',
      sources: ['scan:~/Documents/acme.md'],
      at: '2026-11-02T09:00:00+09:00',
    }),
    line({
      area: 'project',
      topic: 'Acme',
      key: 'status',
      text: '진행 중',
      sources: ['scan:~/Documents/acme.md'],
      at: '2026-11-03T09:00:00+09:00',
    }),
    line({ area: 'work', topic: '회사', key: 'w1', text: '회의 준비', at: '2026-11-04T09:00:00+09:00' }),
  ]);
}

describe('baseline', () => {
  it('writes every document and a baseline changelog section', async () => {
    const { store, fs, builder } = await setup();
    await seed(store);

    const result = await builder.rebuild();

    expect(result.files).toEqual(
      expect.arrayContaining(['README.md', '프로필.md', '프로젝트/Acme.md', '분야/일.md', '변경기록.md']),
    );
    const changelog = fs.files.get('/kb/변경기록.md') ?? '';
    expect(changelog).toContain('# 변경 기록');
    expect(changelog).toContain('기준점 생성 (4줄)');

    const readme = fs.files.get('/kb/README.md') ?? '';
    expect(readme).toContain('> 프로필 1줄 · 프로젝트 1개 · 분야 1개 · 갱신 2026-11-17 09:00 (Asia/Seoul)');
    expect(readme).toContain('- [Acme](<프로젝트/Acme.md>) — 진행 중');
    expect(readme).toContain('- [일](<분야/일.md>) — 1줄');
  });

  it('rewrites nothing when a later run found nothing new', async () => {
    const { store, fs, builder } = await setup();
    await seed(store);
    await builder.rebuild();
    const writes = fs.writes.length;

    const second = await builder.rebuild();

    expect(second.files).toEqual([]);
    expect(fs.writes).toHaveLength(writes);
  });

  it('prepends a new section above the baseline', async () => {
    const { store, clock, fs, builder } = await setup();
    await seed(store);
    await builder.rebuild();

    await clock.advance(DAY);
    await store.replaceOrigin('memory', [
      line({ area: 'health', topic: '나', key: 'h1', text: '수면이 부족함', at: '2026-11-18T08:00:00+09:00' }),
    ]);
    await builder.rebuild();

    const changelog = fs.files.get('/kb/변경기록.md') ?? '';
    expect(changelog).toContain('**추가**');
    expect(changelog.indexOf('## 2026-11-18 09:00')).toBeLessThan(changelog.indexOf('## 2026-11-17 09:00'));
  });
});

describe('removed documents', () => {
  it('deletes a project file that no longer has any line', async () => {
    const { store, fs, builder } = await setup();
    await seed(store);
    await builder.rebuild();
    expect(fs.files.has('/kb/프로젝트/Acme.md')).toBe(true);

    await store.replaceOrigin('scan', []);
    await builder.rebuild();

    expect(fs.files.has('/kb/프로젝트/Acme.md')).toBe(false);
    expect(fs.removed).toContain('/kb/프로젝트/Acme.md');
    expect(fs.files.get('/kb/README.md')).not.toContain('Acme');
  });
});

describe('in-memory documents', () => {
  it('answers by README, profile, project name and area id or title', async () => {
    const { store, builder } = await setup();
    await seed(store);
    await builder.rebuild();

    expect(builder.document('README')).toContain('# 지식 문서');
    expect(builder.document('profile')).toContain('# 프로필');
    expect(builder.document('Acme')).toContain('# Acme');
    expect(builder.document('work')).toBe(builder.document('일'));
    expect(builder.document('회의')).toBeUndefined();
    expect(builder.docNames()).toEqual(expect.arrayContaining(['README', 'profile', 'Acme', 'work']));
  });

  it('works without a writer and still keeps the snapshot', async () => {
    const { kv, store, builder } = await setup(false);
    await seed(store);

    const result = await builder.rebuild();

    expect(result.files).toEqual([]);
    expect(builder.document('README')).toContain('# 지식 문서');
    const snapshot = await kv.get<Record<string, string>>('snapshot');
    expect(Object.keys(snapshot ?? {})).toHaveLength(4);
  });
});

describe('company folders', () => {
  it('files a project with a company line under 프로젝트/<회사>/ and writes a company index', async () => {
    const { store, fs, builder } = await setup();
    const at = '2026-11-05T09:00:00+09:00';
    await store.replaceOrigin('scan', [
      line({ area: 'project', topic: 'acme-web', key: 'company', text: 'ACME', sources: ['setup'], at }),
      line({ area: 'project', topic: 'acme-web', key: 'purpose', text: '커뮤니티 웹', sources: ['~/dev/acme-web'], at }),
      line({ area: 'project', topic: 'acme-web', key: 'decisions', text: 'PR은 리뷰 후 병합', sources: ['~/dev/acme-web'], at }),
      line({ area: 'project', topic: 'acme-web', key: 'open', text: '소셜 로그인', sources: ['~/dev/acme-web'], at }),
      line({ area: 'project', topic: 'Loose', key: 'purpose', text: '혼자 하는 일', sources: ['~/x'], at }),
    ]);

    const result = await builder.rebuild();

    expect(result.files).toEqual(expect.arrayContaining(['프로젝트/ACME/acme-web.md', '프로젝트/ACME/README.md', '프로젝트/Loose.md']));
    const doc = fs.files.get('/kb/프로젝트/ACME/acme-web.md') ?? '';
    expect(doc).toContain('회사: ACME');
    expect(doc).toContain('## 정한 것');
    expect(doc).toContain('## 남은 일');
    expect(doc).not.toContain('- ACME _(');
    expect(fs.files.get('/kb/프로젝트/ACME/README.md') ?? '').toContain('[acme-web](<acme-web.md>)');
    const readme = fs.files.get('/kb/README.md') ?? '';
    expect(readme).toContain('### ACME');
    expect(readme).toContain('[acme-web](<프로젝트/ACME/acme-web.md>)');
    expect(readme).toContain('[Loose](<프로젝트/Loose.md>)');
  });
});

describe('shared sources', () => {
  it('cites the same files once under a section instead of on every line', async () => {
    const { store, fs, builder } = await setup();
    const at = '2026-11-05T09:00:00+09:00';
    const src = ['~/w/a.md', '~/w/b.md'];
    await store.replaceOrigin('scan', [
      line({ area: 'project', topic: 'p', key: 'decisions', text: '첫째 결정', sources: src, at }),
      line({ area: 'project', topic: 'p', key: 'decisions-2', text: '둘째 결정', sources: src, at }),
      line({ area: 'project', topic: 'p', key: 'purpose', text: '목적', sources: ['~/w/c.md'], at }),
    ]);
    await builder.rebuild();
    const doc = fs.files.get('/kb/프로젝트/p.md') ?? '';
    expect(doc).toContain('- 둘째 결정\n- 첫째 결정\n\n_(출처: ~/w/a.md, ~/w/b.md · 2026-11-05)_');
    expect(doc).toContain('- 목적 _(출처: ~/w/c.md · 2026-11-05)_');
  });
});
