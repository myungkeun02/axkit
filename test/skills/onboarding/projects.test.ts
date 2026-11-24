import { describe, expect, it } from 'vitest';
import type { RepoRoot } from '../../../src/core/contracts/scan.js';
import type { AgentSession } from '../../../src/core/contracts/sessions.js';
import { byCompany, discoverProjects, guessCompany, sessionsOf } from '../../../src/skills/onboarding/projects.js';

const HOME = '/Users/me';

function session(tool: AgentSession['tool'], cwd: string, updatedAt: string, turns = 5): AgentSession {
  return { tool, id: `${tool}-${cwd}-${updatedAt}`, cwd, startedAt: updatedAt, updatedAt, turns };
}

const ROOTS: Record<string, RepoRoot> = {
  '/Users/me/dev/acme/web': { root: '/Users/me/dev/acme/web', display: '~/dev/acme/web', name: 'web', remote: 'github.com/acme/acme-web' },
  // A Claude worktree resolves to its main checkout.
  '/Users/me/.claude-worktrees/acme-web/fix': { root: '/Users/me/dev/acme/web', display: '~/dev/acme/web', name: 'web', remote: 'github.com/acme/acme-web' },
  '/Users/me/dev/side': { root: '/Users/me/dev/side', display: '~/dev/side', name: 'side' },
  '/Users/me/old/acme-web': { root: '/Users/me/old/acme-web', display: '~/old/acme-web', name: 'acme-web', remote: 'github.com/acme/acme-web' },
};

describe('discoverProjects', () => {
  it('ties sessions to repositories, merges checkouts of one repo and names companies', async () => {
    const list = await discoverProjects({
      repos: [
        { id: '/Users/me/dev/acme/web', path: '~/dev/acme/web', name: 'web', modifiedAt: '2026-11-01T00:00:00.000Z' },
        { id: '/Users/me/old/acme-web', path: '~/old/acme-web', name: 'acme-web', modifiedAt: '2025-01-01T00:00:00.000Z' },
      ],
      sessions: [
        session('claude', '/Users/me/.claude-worktrees/acme-web/fix', '2026-11-20T00:00:00.000Z'),
        session('codex', '/Users/me/dev/acme/web', '2026-11-19T00:00:00.000Z'),
        session('claude', '/Users/me/dev/side', '2026-10-01T00:00:00.000Z'),
        // A folder holding repositories and a scratch folder are never projects.
        session('claude', '/Users/me/dev', '2026-11-21T00:00:00.000Z', 20),
        session('claude', '/Users/me/Library/Application Support/x', '2026-11-21T00:00:00.000Z', 20),
        // A loose folder with enough turns counts.
        session('claude', '/Users/me/notes/plan', '2026-09-01T00:00:00.000Z', 4),
        session('claude', '/Users/me/notes/tiny', '2026-09-01T00:00:00.000Z', 1),
      ],
      locate: async (path) => ROOTS[path],
      home: HOME,
      personal: '개인',
    });
    expect(list.map((item) => [item.name, item.company, item.claude, item.codex])).toEqual([
      ['acme-web', 'acme', 1, 1],
      ['side', '개인', 1, 0],
      ['plan', 'notes', 1, 0],
    ]);
    expect(list[0]?.path).toBe('/Users/me/dev/acme/web');
    expect(list[0]?.inFolders).toBe(true);
    expect(byCompany(list)).toEqual(['acme', '개인', 'notes']);
  });

  it('guesses a company from the remote, else a meaningful parent folder', () => {
    expect(guessCompany('/Users/me/dev/a', 'gitlab.com/betalab/a', HOME, '개인')).toBe('betalab');
    expect(guessCompany('/Users/me/dev/betalab/a', undefined, HOME, '개인')).toBe('betalab');
    expect(guessCompany('/Users/me/projects/a', undefined, HOME, '개인')).toBe('개인');
    // an AI tool's own folder is not a company
    expect(guessCompany('/Users/me/Documents/ChatGPT/betalab', undefined, HOME, '개인')).toBe('개인');
    expect(guessCompany('/Users/me/Documents/Codex/2026-07-06', undefined, HOME, '개인')).toBe('개인');
  });

  it('finds a project’s sessions, including ones inside its folders', () => {
    const sessions = [session('claude', '/a/app', 'x'), session('codex', '/a/app/sub', 'y'), session('claude', '/a/apple', 'z')];
    expect(sessionsOf({ path: '/a/app' }, sessions).map((item) => item.cwd)).toEqual(['/a/app', '/a/app/sub']);
  });
});
