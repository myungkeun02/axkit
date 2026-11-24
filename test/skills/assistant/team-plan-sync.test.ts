import { describe, expect, it } from 'vitest';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { applyPlan } from '../../../src/core/bots/from-scan.js';
import { syncBuiltTeams } from '../../../src/skills/assistant/team-plan-sync.js';
import type { PlanTeam } from '../../../src/skills/assistant/team-plan.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const NOW = new Date('2026-11-23T00:00:00Z');
const team = (company: string, name: string): PlanTeam => ({ company, name, purpose: '', kind: 'general', roles: [], tasks: [], routines: [] });

describe('syncBuiltTeams', () => {
  it('moves a built team and its bots to the new company, renames, adds, and never deletes', async () => {
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => NOW);
    const before = [team('betalab', 'event-processing'), team('betalab', 'clipper'), team('betalab', '영수증_정리')];
    await applyPlan(directory, before, true, NOW);
    const after = [team('ACME', 'event-processing'), team('betalab', 'Clipper 영상 편집'), team('betalab', '새 프로젝트')];
    const result = await syncBuiltTeams(directory, before, after, new Map([['clipper', 'Clipper 영상 편집']]), { korean: true, now: NOW });

    expect(result).toMatchObject({ moved: 1, renamed: 1, added: 1 });
    expect(result.notApplied).toEqual(["'영수증_정리' 팀 지우기 (앱의 팀 화면에서 지워요)"]);
    const groups = await directory.groups();
    const acme = groups.find((group) => group.label === 'ACME');
    const teams = await directory.teams();
    const moved = teams.find((item) => item.name === 'event-processing');
    expect(moved?.group).toBe(acme?.id);
    expect((await directory.list()).filter((bot) => bot.team === moved?.id).every((bot) => bot.group === acme?.id)).toBe(true);
    expect(teams.map((item) => item.name).sort()).toEqual(['Clipper 영상 편집', 'event-processing', '새 프로젝트', '영수증_정리'].sort());
    const renamedBots = (await directory.list()).filter((bot) => bot.team === teams.find((item) => item.name === 'Clipper 영상 편집')?.id);
    expect(renamedBots.every((bot) => bot.name.startsWith('Clipper 영상 편집'))).toBe(true);
  });
});
