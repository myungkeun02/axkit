import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { agentSessionsConnector } from '../../../src/connectors/agent-sessions/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import { tempHome, writeLines } from './helpers.js';

describe('agentSessionsConnector', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ home, cleanup } = await tempHome()));
  afterEach(async () => cleanup());

  it('declares the connector identity', () => {
    expect(agentSessionsConnector().manifest).toMatchObject({ id: 'connector.agent-sessions', kind: 'connector' });
  });

  it('provides sessions.agents reading the given home', async () => {
    await writeLines(join(home, '.claude', 'projects', 'p', 's1.jsonl'), [
      { type: 'user', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
    ]);
    const { ctx, provided } = createTestContext();

    await agentSessionsConnector({ home }).setup(ctx);

    expect(provided.has('sessions.agents')).toBe(true);
    const sessions = await ctx.use(Contracts.agentSessions).list();
    expect(sessions.map((s) => [s.tool, s.id, s.turns])).toEqual([['claude', 's1', 1]]);
  });
});
