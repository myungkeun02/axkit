import { describe, expect, it } from 'vitest';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { applyPlan } from '../../../src/core/bots/from-scan.js';
import { teamName } from '../../../src/core/contracts/bots.js';
import { MapKeyValueStore } from '../helpers.js';

const team = (name: string, kind: 'dev' | 'general') => ({ company: 'betalab', name, purpose: '', kind, roles: [], tasks: [] });

describe('applyPlan', () => {
  it('builds exactly the approved teams, with no extra company-wide team', async () => {
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date('2026-11-23T00:00:00Z'));
    const made = await applyPlan(directory, [team('clipper', 'dev'), team('betalab-expert-review-marketplace', 'general')], true, new Date('2026-11-23T00:00:00Z'));
    expect(made).toBe(2);
    expect((await directory.teams()).map((item) => item.name)).toEqual(['clipper', 'betalab-expert-review-marketplace']);
  });
});

describe('teamName', () => {
  it('keeps names up to 40 characters and cuts longer ones at a word with "…"', () => {
    expect(teamName('  betalab-expert-review-marketplace  ')).toBe('betalab-expert-review-marketplace');
    const long = teamName('betalab-expert-review-marketplace-and-more-things');
    expect([...long].length).toBeLessThanOrEqual(40);
    expect(long).toBe('betalab-expert-review-marketplace-and…');
  });
});
