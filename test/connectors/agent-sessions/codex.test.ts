import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeSessionFs } from '../../../src/connectors/agent-sessions/fs.js';
import { LocalAgentSessionReader } from '../../../src/connectors/agent-sessions/reader.js';
import { TOKEN, tempHome, writeLines } from './helpers.js';

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = '99999999-8888-7777-6666-555555555555';
const ID_OLD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function rollout(id: string, cwd: string, start: string, extra: object[] = []): (object | string)[] {
  return [
    {
      timestamp: start,
      type: 'session_meta',
      payload: { id, timestamp: start, cwd, git: { branch: 'dev', repository_url: 'git@github.com:me/tool.git' } },
    },
    {
      timestamp: start,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
    },
    {
      timestamp: start,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Make the parser faster' }] },
    },
    { timestamp: start, type: 'event_msg', payload: { type: 'user_message', message: 'Make the parser faster' } },
    { timestamp: start, type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { timestamp: start, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
    {
      timestamp: start,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Profiling first.' }] },
    },
    { timestamp: start, type: 'event_msg', payload: { type: 'agent_message', message: 'Profiling first.' } },
    'garbage',
    ...extra,
  ];
}

function makeDb(path: string, schema: string, rows: Record<string, unknown>[]): void {
  const db = new DatabaseSync(path);
  db.exec(schema);
  for (const row of rows) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO threads (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
      ...(Object.values(row) as (string | number | null)[]),
    );
  }
  db.close();
}

const FULL_SCHEMA = `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
  cwd TEXT, title TEXT, first_user_message TEXT, git_branch TEXT, git_origin_url TEXT, archived INTEGER,
  created_at_ms INTEGER, updated_at_ms INTEGER)`;

describe('Codex sessions', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let reader: LocalAgentSessionReader;

  beforeEach(async () => {
    ({ home, cleanup } = await tempHome());
    reader = new LocalAgentSessionReader({ fs: nodeSessionFs, home });
  });
  afterEach(async () => cleanup());

  const codex = (...parts: string[]): string => join(home, '.codex', ...parts);

  it('merges the newest state database with rollout files, de-duplicated by id', async () => {
    const pathA = codex('sessions', '2026', '03', '04', `rollout-2026-03-04T10-00-00-${ID_A}.jsonl`);
    await writeLines(pathA, rollout(ID_A, '/Users/me/dev/tool', '2026-03-04T10:00:00.000Z'));
    await writeLines(
      codex('sessions', '2026', '03', '01', `rollout-2026-03-01T08-00-00-${ID_B}.jsonl`),
      rollout(ID_B, '/Users/me/dev/other', '2026-03-01T08:00:00.000Z'),
    );
    await mkdir(codex(), { recursive: true });
    makeDb(codex('state_3.sqlite'), FULL_SCHEMA, [{ id: 'stale', cwd: '/x', first_user_message: 'old db', created_at: 1 }]);
    makeDb(codex('state_5.sqlite'), FULL_SCHEMA, [
      {
        id: ID_A,
        rollout_path: pathA,
        created_at: 1,
        created_at_ms: Date.parse('2026-03-04T10:00:00.000Z'),
        updated_at: 2,
        updated_at_ms: Date.parse('2026-03-05T12:00:00.000Z'),
        cwd: '/Users/me/dev/tool',
        title: `Speed up parser ${TOKEN}`,
        first_user_message: 'Make the parser faster',
        git_branch: 'feature/speed',
        git_origin_url: 'https://me:ghp_secret@github.com/me/tool.git',
        archived: 0,
      },
    ]);

    const sessions = await reader.list();

    expect(sessions).toEqual([
      {
        tool: 'codex',
        id: ID_A,
        cwd: '/Users/me/dev/tool',
        title: 'Speed up parser [masked]',
        firstPrompt: 'Make the parser faster',
        startedAt: '2026-03-04T10:00:00.000Z',
        updatedAt: '2026-03-05T12:00:00.000Z',
        turns: 1,
        gitBranch: 'feature/speed',
        gitRemote: 'github.com/me/tool',
      },
      {
        tool: 'codex',
        id: ID_B,
        cwd: '/Users/me/dev/other',
        firstPrompt: 'Make the parser faster',
        startedAt: '2026-03-01T08:00:00.000Z',
        updatedAt: '2026-03-01T08:00:00.000Z',
        turns: 1,
        gitBranch: 'dev',
        gitRemote: 'github.com/me/tool',
      },
    ]);
  });

  it('reads an older schema with only the columns it has, and a database-only thread', async () => {
    await mkdir(codex(), { recursive: true });
    makeDb(codex('state_1.sqlite'), 'CREATE TABLE threads (id TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, first_user_message TEXT)', [
      { id: ID_OLD, created_at: 1_700_000_000, updated_at: 1_700_000_600, cwd: '/w', first_user_message: 'Hello  there' },
    ]);

    const sessions = await reader.list();

    expect(sessions).toEqual([
      {
        tool: 'codex',
        id: ID_OLD,
        cwd: '/w',
        firstPrompt: 'Hello there',
        startedAt: new Date(1_700_000_000_000).toISOString(),
        updatedAt: new Date(1_700_000_600_000).toISOString(),
        turns: 1,
      },
    ]);
    await expect(reader.transcript({ tool: 'codex', id: ID_OLD }, 100)).resolves.toBeUndefined();
  });

  it('treats a corrupt database as no rows and still reads rollouts', async () => {
    await mkdir(codex(), { recursive: true });
    await writeFile(codex('state_9.sqlite'), 'this is not sqlite');
    await writeLines(
      codex('sessions', '2026', '01', '01', `rollout-x-${ID_B}.jsonl`),
      rollout(ID_B, '/w', '2026-01-01T00:00:00.000Z'),
    );
    const sessions = await reader.list();
    expect(sessions.map((s) => s.id)).toEqual([ID_B]);
  });

  it('renders the transcript once per turn, without injected context or tool calls', async () => {
    await writeLines(
      codex('sessions', '2026', '01', '01', `rollout-x-${ID_B}.jsonl`),
      rollout(ID_B, '/w', '2026-01-01T00:00:00.000Z', [
        { type: 'event_msg', payload: { type: 'user_message', message: `<system-reminder>x</system-reminder>key ${TOKEN}` } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure.' }] } },
      ]),
    );

    const text = await reader.transcript({ tool: 'codex', id: ID_B }, 10_000);

    expect(text).toBe(['owner: Make the parser faster', 'assistant: Profiling first.', 'owner: key [masked]', 'assistant: Sure.'].join('\n'));
  });

  it('falls back to response_item user messages when there are no user events', async () => {
    await writeLines(codex('sessions', '2026', '01', '01', `rollout-x-${ID_B}.jsonl`), [
      { type: 'session_meta', payload: { id: ID_B, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/w' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w\n...' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Only items here' }] } },
    ]);

    const [session] = await reader.list();

    expect(session).toMatchObject({ id: ID_B, turns: 1, firstPrompt: 'Only items here', startedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('ignores rollouts deeper than four folders', async () => {
    await writeLines(
      codex('sessions', '2026', '01', '01', 'extra', `rollout-x-${ID_B}.jsonl`),
      rollout(ID_B, '/w', '2026-01-01T00:00:00.000Z'),
    );
    await expect(reader.list()).resolves.toEqual([]);
  });
});
