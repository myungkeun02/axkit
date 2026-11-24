import { describe, expect, it } from 'vitest';
import { applyCompanyEdits, askProjects, parseSelection } from '../../src/cli/setup-projects.js';
import type { ProjectCandidate } from '../../src/skills/onboarding/projects.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';

const NOW = new Date('2026-11-23T00:00:00.000Z');

function candidate(name: string, company: string, lastActive: string, extra: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return { path: `/u/${name}`, display: `~/${name}`, name, company, lastActive, claude: 2, codex: 0, inFolders: true, ...extra };
}

const LIST = [
  candidate('acme-web', 'acme', '2026-11-20T00:00:00.000Z'),
  candidate('acme-api', 'acme', '2026-11-01T00:00:00.000Z'),
  candidate('old', 'acme', '2025-01-01T00:00:00.000Z'),
  candidate('blog', '개인', '2026-11-22T00:00:00.000Z', { codex: 3 }),
];

describe('askProjects', () => {
  it('pre-checks recent projects by company and keeps them on enter', async () => {
    const prompter = createScriptedPrompter(['', '']);
    const picked = await askProjects({ prompter, candidates: LIST, previous: [], now: NOW });
    // The newest company first, in one checklist; recent ones are checked.
    expect(picked.map((item) => item.name)).toEqual(['blog', 'acme-web', 'acme-api']);
    expect(prompter.said).toContain('비서가 알아 둘 프로젝트를 골라 주세요');
  });

  it('labels each project with its company and activity for the checklist', async () => {
    const seen: { label: string; checked?: boolean }[] = [];
    const prompter = { ...createScriptedPrompter(['']), chooseMany: async (_q: string, options: readonly { value: string; label: string; checked?: boolean }[]) => (seen.push(...options), []) };
    await askProjects({ prompter, candidates: LIST, previous: [], now: NOW });
    expect(seen.map((option) => [option.label, option.checked])).toEqual([
      ['[개인] blog  · 1일 전 · Claude 2 · Codex 3', true],
      ['[acme] acme-web  · 3일 전 · Claude 2', true],
      ['[acme] acme-api  · 22일 전 · Claude 2', true],
      ['[acme] old  · 1년 전 · Claude 2', false],
    ]);
  });

  it('takes ranges and renames or moves companies', async () => {
    const prompter = createScriptedPrompter(['2-4', 'acme=ACME, 4=이브레인']);
    const picked = await askProjects({ prompter, candidates: LIST, previous: [], now: NOW });
    expect(picked).toEqual([
      { path: '/u/acme-web', name: 'acme-web', company: 'ACME' },
      { path: '/u/acme-api', name: 'acme-api', company: 'ACME' },
      { path: '/u/old', name: 'old', company: '이브레인' },
    ]);
  });

  it('remembers the earlier pick and its company', async () => {
    const prompter = createScriptedPrompter(['', '']);
    const picked = await askProjects({ prompter, candidates: LIST, previous: [{ path: '/u/old', name: '예전', company: '옛 회사' }], now: NOW });
    expect(picked).toEqual([{ path: '/u/old', name: '예전', company: '옛 회사' }]);
  });

  it('parses selections and reports edits it cannot use', () => {
    expect(parseSelection('1-3, 5', 5)).toEqual([1, 2, 3, 5]);
    expect(parseSelection('0', 5)).toBeUndefined();
    expect(parseSelection('2-9', 5)).toBeUndefined();
    const picked = [{ path: '/u/a', name: 'a', company: 'x' }];
    expect(applyCompanyEdits(picked, [], 'nobody=y, broken')).toEqual(['nobody=y', 'broken']);
  });
});
