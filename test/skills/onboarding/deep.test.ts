import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ScannedFile } from '../../../src/core/contracts/scan.js';
import type { AgentSession, AgentSessionReader } from '../../../src/core/contracts/sessions.js';
import { teamsFromScan } from '../../../src/core/bots/from-scan.js';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { BehaviorLlm, FakeFolderScan, FakeKnowledgeWriter, daysAgo, makeRepo, makeWalk, profileJson, setupRunner, summaryJson } from './helpers.js';

class DocsScan extends FakeFolderScan {
  readonly docs = new Map<string, ScannedFile[]>();

  async repoDocs(id: string, max: number): Promise<ScannedFile[]> {
    return (this.docs.get(id) ?? []).slice(0, max);
  }
}

class FakeSessions implements AgentSessionReader {
  readonly read: string[] = [];

  constructor(private readonly sessions: AgentSession[]) {}

  async list(): Promise<AgentSession[]> {
    return this.sessions;
  }

  async transcript(session: Pick<AgentSession, 'tool' | 'id'>): Promise<string> {
    this.read.push(`${session.tool}:${session.id}`);
    return `owner: 로그인 고쳐줘\nassistant: 고쳤어요 (${session.id})`;
  }
}

describe('deep first look over picked projects', () => {
  it('reads each project’s documents and sessions and files one document per project under its company', async () => {
    const scan = new DocsScan(makeWalk([], [makeRepo('/w/acme-web', '~/w/acme-web', daysAgo(1)), makeRepo('/w/toy', '~/w/toy', daysAgo(2))]));
    scan.repos.set('/w/acme-web', { readme: '# ACME 웹', commits: [], languages: [{ ext: 'ts', files: 3 }] });
    scan.docs.set('/w/acme-web', [{ id: '/w/acme-web/docs/plan.md', path: '~/w/acme-web/docs/plan.md', name: 'plan.md', ext: 'md', size: 10, modifiedAt: daysAgo(3), readable: true }]);
    scan.bodies.set('/w/acme-web/docs/plan.md', '# 계획\n로그인 개편');
    const sessions = new FakeSessions([
      { tool: 'claude', id: 's1', cwd: '/w/acme-web', startedAt: daysAgo(2), updatedAt: daysAgo(1), turns: 4, title: '로그인' },
      { tool: 'codex', id: 't1', cwd: '/w/acme-web/api', startedAt: daysAgo(5), updatedAt: daysAgo(4), turns: 2 },
      { tool: 'claude', id: 'other', cwd: '/w/toy', startedAt: daysAgo(2), updatedAt: daysAgo(1), turns: 9 },
    ]);
    const writer = new FakeKnowledgeWriter();
    const llm = new BehaviorLlm((request) => {
      if (request.purpose === 'onboarding.summarize') return summaryJson(`${request.messages.at(-1)?.content.includes('session') === true ? '세션' : '문서'} 요약`);
      if (request.purpose === 'onboarding.project') {
        return JSON.stringify({ purpose: 'ACME 커뮤니티 웹', status: '로그인 개편 중', recent: '로그인 수정', stack: 'TypeScript', decisions: ['PR은 리뷰 후 병합'], open: ['소셜 로그인'], people: [] });
      }
      return profileJson({ profile: [{ topic: 'role', key: 'job', text: '개발 리드', sources: ['F1'] }], projects: [{ name: 'guess', purpose: '추측', sources: ['F1'] }] });
    });
    const setup = await setupRunner({
      llm,
      scan,
      config: { drive: false, signals: false, projects: [{ path: '/w/acme-web', name: 'acme-web', company: 'ACME' }] },
      capabilities: { [Contracts.agentSessions.id]: sessions, [Contracts.knowledgeWrite.id]: writer },
    });

    await setup.runner.run('first', new AbortController().signal);

    expect(setup.state.current.status).toBe('done');
    expect(setup.state.current.counts.docs).toBe(1);
    expect(setup.state.current.counts.sessions).toBe(2);
    // Only the picked project's sessions are read, the subfolder one included.
    expect(sessions.read.sort()).toEqual(['claude:s1', 'codex:t1']);
    expect(llm.ofPurpose('onboarding.project')).toHaveLength(1);
    const project = llm.ofPurpose('onboarding.project')[0]?.messages.at(-1)?.content ?? '';
    expect(project).toContain('company: ACME');
    expect(project).toContain('[session');
    expect(project).toContain('[doc');

    const result = writer.results.at(-1);
    const lines = result?.projects ?? [];
    // The picked project replaces the model's guessed one.
    expect([...new Set(lines.map((line) => line.topic))]).toEqual(['acme-web']);
    expect(lines.find((line) => line.key === 'company')?.text).toBe('ACME');
    expect(lines.filter((line) => line.key === 'decisions').map((line) => line.text)).toEqual(['PR은 리뷰 후 병합']);
    expect(lines.find((line) => line.key === 'open')?.text).toBe('소셜 로그인');
    expect(result?.profile.find((line) => line.topic === 'org')?.text).toBe('ACME: acme-web');

    // Every picked project becomes a dev team inside its company's group, next to the company's work team.
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date('2026-11-19T00:00:00Z'));
    const made = await teamsFromScan(directory, { profile: result?.profile ?? [], projects: lines }, true, new Date('2026-11-19T00:00:00Z'));
    expect(made).toBe(2);
    expect((await directory.groups()).map((group) => group.label)).toEqual(['ACME']);
    const teams = await directory.teams();
    expect(teams.map((team) => [team.name, team.kind])).toEqual([
      ['ACME 업무', 'general'],
      ['acme-web', 'dev'],
    ]);
    // A second scan adds nothing.
    expect(await teamsFromScan(directory, { profile: [], projects: lines }, true, new Date('2026-11-19T00:00:00Z'))).toBe(0);
  });
});
