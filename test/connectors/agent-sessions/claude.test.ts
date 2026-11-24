import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalAgentSessionReader } from '../../../src/connectors/agent-sessions/reader.js';
import { nodeSessionFs } from '../../../src/connectors/agent-sessions/fs.js';
import { TOKEN, link, tempHome, writeLines } from './helpers.js';

const CWD = '/Users/me/dev/app';

function user(content: unknown, at: string, extra: object = {}): object {
  return { type: 'user', cwd: CWD, gitBranch: 'main', timestamp: at, sessionId: 's', message: { role: 'user', content }, ...extra };
}

function assistant(content: unknown, at: string): object {
  return { type: 'assistant', cwd: CWD, gitBranch: 'main', timestamp: at, message: { role: 'assistant', content } };
}

const MAIN = [
  { type: 'queue-operation', operation: 'enqueue' },
  user('<command-name>/clear</command-name><command-args></command-args>', '2026-01-01T09:00:00.000Z'),
  user('Caveat: meta', '2026-01-01T09:00:01.000Z', { isMeta: true }),
  user(`<system-reminder>be nice</system-reminder>Fix the login page, key ${TOKEN} mail a@b.com`, '2026-01-01T09:00:02.000Z'),
  assistant([{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'Looking   at\n it.' }], '2026-01-01T09:00:03.000Z'),
  assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], '2026-01-01T09:00:04.000Z'),
  user([{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }], '2026-01-01T09:00:05.000Z'),
  '{not json',
  user([{ type: 'text', text: 'Now add tests' }, { type: 'image', source: {} }], '2026-01-01T09:00:06.000Z'),
  assistant([{ type: 'text', text: 'Done.' }], '2026-01-01T09:30:00.000Z'),
  { type: 'custom-title', customTitle: 'Login fix', sessionId: 's' },
];

describe('Claude Code sessions', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let reader: LocalAgentSessionReader;

  beforeEach(async () => {
    ({ home, cleanup } = await tempHome());
    reader = new LocalAgentSessionReader({ fs: nodeSessionFs, home });
  });
  afterEach(async () => cleanup());

  const project = (slug: string, file: string): string => join(home, '.claude', 'projects', slug, file);

  it('lists owner sessions with metadata, newest first, masking secrets', async () => {
    await writeLines(project('-Users-me-dev-app', 'aaa.jsonl'), MAIN);
    await writeLines(project('-Users-me-dev-other', 'bbb.jsonl'), [
      { type: 'summary', summary: 'Older work' },
      user('Old request', '2025-12-01T10:00:00.000Z'),
    ]);
    // Only tool results: the owner never wrote.
    await writeLines(project('-Users-me-dev-app', 'ccc.jsonl'), [
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'x' }], '2026-02-01T00:00:00.000Z'),
    ]);
    await writeLines(project('-Users-me-dev-app', join('aaa', 'subagents', 'agent-1.jsonl')), MAIN);
    await link(project('-Users-me-dev-app', 'aaa.jsonl'), project('-Users-me-dev-app', 'linked.jsonl'));

    const sessions = await reader.list();

    expect(sessions.map((s) => s.id)).toEqual(['aaa', 'bbb']);
    expect(sessions[0]).toEqual({
      tool: 'claude',
      id: 'aaa',
      cwd: CWD,
      title: 'Login fix',
      firstPrompt: 'Fix the login page, key [masked] mail [email]',
      startedAt: '2026-01-01T09:00:00.000Z',
      updatedAt: '2026-01-01T09:30:00.000Z',
      turns: 2,
      gitBranch: 'main',
    });
    expect(sessions[1]).toMatchObject({ title: 'Older work', turns: 1, firstPrompt: 'Old request' });
  });

  it('caps the first prompt at 200 characters on one line', async () => {
    await writeLines(project('p', 'long.jsonl'), [user(`word\n${'x '.repeat(300)}`, '2026-01-01T00:00:00.000Z')]);
    const [session] = await reader.list();
    expect(session!.firstPrompt!.length).toBe(200);
    expect(session!.firstPrompt).not.toContain('\n');
  });

  it('renders the transcript with only visible owner and assistant text', async () => {
    await writeLines(project('p', 'aaa.jsonl'), MAIN);

    const text = await reader.transcript({ tool: 'claude', id: 'aaa' }, 10_000);

    expect(text).toBe(
      ['owner: Fix the login page, key [masked] mail [email]', 'assistant: Looking at it.', 'owner: Now add tests', 'assistant: Done.'].join(
        '\n',
      ),
    );
  });

  it('keeps the start and the end of a long transcript', async () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? user(`question ${i}`, '2026-01-01T00:00:00.000Z') : assistant(`answer ${i}`, '2026-01-01T00:00:00.000Z'),
    );
    await writeLines(project('p', 'big.jsonl'), lines);

    const text = (await reader.transcript({ tool: 'claude', id: 'big' }, 200))!;

    expect(text.length).toBe(200);
    expect(text.startsWith('owner: question 0')).toBe(true);
    expect(text.endsWith('assistant: answer 39')).toBe(true);
    expect(text).toContain('\n…\n');
  });

  it('returns undefined for unknown, unsafe or linked ids and lists nothing without a .claude folder', async () => {
    await expect(reader.list()).resolves.toEqual([]);
    await writeLines(join(home, 'outside.jsonl'), MAIN);
    await link(join(home, 'outside.jsonl'), project('p', 'linked.jsonl'));
    await expect(reader.transcript({ tool: 'claude', id: 'missing' }, 100)).resolves.toBeUndefined();
    await expect(reader.transcript({ tool: 'claude', id: '../../../outside' }, 100)).resolves.toBeUndefined();
    await expect(reader.transcript({ tool: 'claude', id: 'linked' }, 100)).resolves.toBeUndefined();
  });

  it('stops when the signal is aborted', async () => {
    await writeLines(project('p', 'aaa.jsonl'), MAIN);
    const controller = new AbortController();
    controller.abort();
    await expect(reader.list(controller.signal)).rejects.toThrow();
  });

  it('ignores stray files and folders in the projects root', async () => {
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    await writeFile(join(home, '.claude', 'projects', 'loose.jsonl'), JSON.stringify(MAIN[3]));
    await writeLines(project('p', 'notes.txt'), MAIN);
    await expect(reader.list()).resolves.toEqual([]);
  });
});
