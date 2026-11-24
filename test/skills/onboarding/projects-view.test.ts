import { describe, expect, it } from 'vitest';
import { ViewInputError } from '../../../src/core/contracts/device-api.js';
import type { ProjectFinder } from '../../../src/skills/onboarding/discover.js';
import type { PickedProject, ProjectCandidate } from '../../../src/skills/onboarding/projects.js';
import { projectsView } from '../../../src/skills/onboarding/projects-view.js';
import { RunStateStore } from '../../../src/skills/onboarding/state.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const FOUND: ProjectCandidate[] = [
  { path: '/u/acme-web', display: '~/acme-web', name: 'acme-web', company: 'acme', lastActive: '2026-11-20T00:00:00.000Z', claude: 3, codex: 1, inFolders: true },
  { path: '/u/blog', display: '~/blog', name: 'blog', company: '개인', lastActive: '2026-11-10T00:00:00.000Z', claude: 0, codex: 0, inFolders: true },
];

async function setup(initial: PickedProject[] = []) {
  let picked = initial;
  let refreshed = 0;
  const finder = {
    async candidates(refresh = false) {
      if (refresh) refreshed += 1;
      return FOUND;
    },
  } as unknown as ProjectFinder;
  const state = new RunStateStore(new MapKeyValueStore());
  await state.load();
  let started = 0;
  const view = projectsView({
    finder,
    picked: () => picked,
    save: async (next) => {
      picked = next;
    },
    state: () => state.current,
    running: () => false,
    start: () => {
      started += 1;
      return 'started';
    },
    korean: true,
  });
  return { view, picked: () => picked, started: () => started, refreshed: () => refreshed };
}

describe('projects view', () => {
  it('lists found projects by company with the owner’s picks and names', async () => {
    const { view } = await setup([
      { path: '/u/acme-web', name: '오키 웹', company: 'ACME' },
      { path: '/u/gone', name: 'gone', company: 'ACME' },
    ]);
    const data = (await view.read(new URLSearchParams())) as { companies: { name: string; projects: { name: string; picked: boolean; path: string }[] }[]; picked: number };
    expect(data.companies.map((company) => company.name)).toEqual(['ACME', '개인']);
    expect(data.companies[0]?.projects.map((project) => [project.name, project.picked])).toEqual([
      ['오키 웹', true],
      ['gone', true],
    ]);
    expect(data.picked).toBe(2);
  });

  it('saves only folders it found and can start reading them now', async () => {
    const { view, picked, started, refreshed } = await setup();
    const save = view.actions?.['save'];
    expect(await save?.({ projects: [{ path: '/u/blog', name: 'blog', company: '내 일' }], rescan: true })).toEqual({ saved: 1, scan: 'started' });
    expect(picked()).toEqual([{ path: '/u/blog', name: 'blog', company: '내 일' }]);
    expect(started()).toBe(1);
    await expect(save?.({ projects: [{ path: '/etc', name: 'x', company: 'y' }] })).rejects.toBeInstanceOf(ViewInputError);
    await expect(save?.({ projects: 'nope' })).rejects.toBeInstanceOf(ViewInputError);
    await view.actions?.['refresh']?.({});
    expect(refreshed()).toBe(1);
  });
});
