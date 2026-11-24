import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { teamsFromScan } from '../../../src/core/bots/from-scan.js';
import { documentFolders } from '../../../src/skills/onboarding/projects.js';
import { clusterKey } from '../../../src/skills/onboarding/work-map.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { BehaviorLlm, FakeFolderScan, FakeKnowledgeWriter, daysAgo, makeFile, makeWalk, profileJson, setupRunner } from './helpers.js';

const HOME = '/Users/me';

function file(path: string, ext: string) {
  return { id: `${HOME}/${path}`, path: `~/${path}`, name: path.split('/').at(-1) ?? path, ext, size: 10, modifiedAt: new Date().toISOString(), readable: true };
}

describe('work map for any kind of work', () => {
  it('finds folders full of documents, not only code', () => {
    const files = [
      ...['a', 'b', 'c', 'd', 'e'].map((name) => file(`Documents/브랜드A 리뉴얼/${name}.pdf`, 'pdf')),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((name) => file(`생산관리/2026/${name}.xlsx`, 'xlsx')),
      ...['a', 'b'].map((name) => file(`Documents/작은폴더/${name}.pdf`, 'pdf')),
      ...['a', 'b', 'c', 'd', 'e'].map((name) => file(`Documents/사진/${name}.png`, 'png')),
    ];
    expect(documentFolders(files, HOME).map((folder) => [folder.path, folder.count])).toEqual([
      [`${HOME}/Documents/브랜드A 리뉴얼`, 5],
      [`${HOME}/생산관리`, 6],
    ]);
    expect(clusterKey('~/Documents/브랜드A/시안/a.pdf')).toBe('~/Documents/브랜드A');
  });

  it('turns a designer’s folders into a company, projects and teams whose staff do that work', async () => {
    const at = daysAgo(3);
    const scan = new FakeFolderScan(
      makeWalk([
        makeFile('/u/Documents/브랜드A/brief.md', '~/Documents/브랜드A/brief.md', 'md', at, 10),
        makeFile('/u/Documents/브랜드A/피드백.md', '~/Documents/브랜드A/피드백.md', 'md', at, 10),
        makeFile('/u/Documents/전시 포스터/기획.md', '~/Documents/전시 포스터/기획.md', 'md', at, 10),
        makeFile('/u/Documents/전시 포스터/일정.md', '~/Documents/전시 포스터/일정.md', 'md', at, 10),
      ]),
    );
    for (const id of ['/u/Documents/브랜드A/brief.md', '/u/Documents/브랜드A/피드백.md', '/u/Documents/전시 포스터/기획.md', '/u/Documents/전시 포스터/일정.md']) scan.bodies.set(id, '# 문서');
    const writer = new FakeKnowledgeWriter();
    const map = {
      occupation: '브랜드 디자이너',
      summary: '스튜디오에서 브랜드와 포스터를 디자인해요.',
      orgs: [
        {
          name: '스튜디오 오름',
          relation: 'employer',
          projects: [
            { ref: 'G1', name: '브랜드A 리뉴얼', purpose: '브랜드A 로고·가이드 개편', kind: 'general', tasks: ['시안 3안 만들기', '피드백 반영'], roles: [{ title: '레퍼런스 조사', does: '비슷한 브랜드 사례를 모아요' }, { title: '피드백 정리', does: '고객 피드백을 정리해요' }] },
            { ref: 'G2', name: '전시 포스터', purpose: '가을 전시 포스터', kind: 'general', tasks: ['인쇄 일정 챙기기'], roles: [{ title: '일정 관리', does: '인쇄·납품 일정을 챙겨요' }] },
          ],
        },
      ],
    };
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') return JSON.stringify({ summary: '디자인 문서', keywords: [], type: 'plan' });
      if (request.purpose === 'onboarding.workmap') return JSON.stringify(map);
      return profileJson({ profile: [{ topic: 'role', key: 'occupation', text: '모델이 추측한 직업', sources: ['F1'] }], projects: [{ name: '추측', purpose: 'x', sources: ['F1'] }] });
    });
    const setup = await setupRunner({ llm, scan, config: { drive: false, signals: false }, capabilities: { [Contracts.knowledgeWrite.id]: writer } });

    await setup.runner.run('first', new AbortController().signal);

    const workmap = llm.ofPurpose('onboarding.workmap')[0]?.messages.at(-1)?.content ?? '';
    expect(workmap).toContain('~/Documents/브랜드A — 2 files');
    expect(llm.ofPurpose('onboarding.workmap')[0]?.messages[0]?.content).toContain('Assume nothing about their job');
    const result = writer.results.at(-1);
    expect(result?.profile.find((line) => line.key === 'occupation')?.text).toBe('브랜드 디자이너 — 스튜디오에서 브랜드와 포스터를 디자인해요.');
    expect(result?.profile.find((line) => line.topic === 'org')?.text).toBe('스튜디오 오름 (다니는 곳): 브랜드A 리뉴얼, 전시 포스터');
    const lines = result?.projects ?? [];
    expect([...new Set(lines.map((line) => line.topic))]).toEqual(['브랜드A 리뉴얼', '전시 포스터']);
    expect(lines.filter((line) => line.topic === '브랜드A 리뉴얼' && line.key.startsWith('role')).map((line) => [line.key, line.text])).toEqual([
      ['role', '레퍼런스 조사 — 비슷한 브랜드 사례를 모아요'],
      ['role-2', '피드백 정리 — 고객 피드백을 정리해요'],
    ]);

    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date('2026-11-23T00:00:00Z'));
    expect(await teamsFromScan(directory, { profile: result?.profile ?? [], projects: lines }, true, new Date('2026-11-23T00:00:00Z'))).toBe(2);
    expect((await directory.groups()).map((group) => group.label)).toEqual(['스튜디오 오름']);
    const teams = await directory.teams();
    expect(teams.map((team) => [team.name, team.kind])).toEqual([
      ['브랜드A 리뉴얼', 'general'],
      ['전시 포스터', 'general'],
    ]);
    const staff = (await directory.list()).filter((bot) => bot.team === teams[0]?.id && bot.rank === 'staff');
    expect(staff.map((bot) => [bot.name, bot.role])).toEqual([
      ['브랜드A 리뉴얼 레퍼런스 조사', '비슷한 브랜드 사례를 모아요'],
      ['브랜드A 리뉴얼 피드백 정리', '고객 피드백을 정리해요'],
    ]);
    expect(staff[0]?.instructions).toContain('맡은 일: 비슷한 브랜드 사례를 모아요');
  });
});
