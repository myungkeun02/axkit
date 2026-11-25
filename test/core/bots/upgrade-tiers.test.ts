import { describe, expect, it } from 'vitest';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { tierOfBot, upgradeTeamTiers } from '../../../src/core/bots/teams.js';
import type { Bot, BotTeam } from '../../../src/core/contracts/bots.js';
import { MapKeyValueStore } from '../helpers.js';

const at = '2026-11-25T00:00:00Z';
const team = (id: string, decidedBy: 'owner' | 'ai'): BotTeam => ({ id, group: 'g', name: id, kind: 'general', tiers: { lead: 'A', staff: 'B' }, lead: `${id}-lead`, decidedBy, createdAt: at }) as BotTeam;
const bot = (id: string, teamId: string, rank: Bot['rank']): Bot => ({ id, name: id, role: 'x', kind: 'general', status: 'idle', origin: 'owner', rank, team: teamId, createdAt: at }) as Bot;

describe('team tiers at start', () => {
  it('puts every lead on S and lifts staff the harness left on B to A, keeping the owner’s staff choice', async () => {
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date(at));
    await directory.upsertTeam(team('team-ai', 'ai'));
    await directory.upsertTeam(team('team-own', 'owner'));
    for (const b of [bot('team-ai-lead', 'team-ai', 'lead'), bot('team-own-lead', 'team-own', 'lead')]) await directory.upsert(b);
    const set: [string, string][] = [];
    const changed = await upgradeTeamTiers(directory, { setPurpose: async (id: string, tier: string) => void set.push([id, tier]) } as never);
    expect(changed).toBe(2);
    const teams = await directory.teams();
    expect(teams.find((t) => t.id === 'team-ai')?.tiers).toEqual({ lead: 'S', staff: 'A' });
    expect(teams.find((t) => t.id === 'team-own')?.tiers).toEqual({ lead: 'S', staff: 'B' });
    expect(set).toEqual(expect.arrayContaining([['bot.team-ai-lead', 'deep'], ['bot.team-own-lead', 'deep']]));
    expect(tierOfBot({ ...team('x', 'ai'), tiers: { lead: 'C', staff: 'C' } }, bot('l', 'x', 'lead'))).toBe('S');
  });
});
