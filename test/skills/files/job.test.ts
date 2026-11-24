import { describe, expect, it } from 'vitest';
import type { FileSource } from '../../../src/core/contracts/files.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { runFileIndex } from '../../../src/skills/files/index-job.js';
import { FileIndex } from '../../../src/skills/files/store.js';
import { createTestContext } from '../../support/context.js';
import { FakeFileSource, entry } from './helpers.js';

const FIRST = '2026-11-17T01:00:00.000Z';
const SECOND = '2026-11-17T02:00:00.000Z';
const THIRD = '2026-11-17T03:00:00.000Z';

function sources(local: FileSource, drive?: FileSource) {
  return {
    [Contracts.filesLocal.id]: local,
    ...(drive !== undefined ? { [Contracts.filesDrive.id]: drive } : {}),
  };
}

describe('files.index job', () => {
  it('indexes both sources and advances each cursor to the newest file', async () => {
    const local = new FakeFileSource('local')
      .add(entry({ id: 'a.md', modifiedAt: FIRST }), 'hello world')
      .add(entry({ id: 'b.md', modifiedAt: SECOND }), 'another note');
    const drive = new FakeFileSource('drive').add(entry({ id: 'd1', modifiedAt: THIRD }), 'drive text');
    const { ctx, kv } = createTestContext({ capabilities: sources(local, drive) });
    const index = new FileIndex(kv);

    await runFileIndex(ctx, index);

    const saved = new FileIndex(kv);
    expect((await saved.search('another', 5)).map((hit) => hit.doc.id)).toEqual(['b.md']);
    expect((await saved.search('drive', 5)).map((hit) => hit.doc.source)).toEqual(['drive']);
    expect(await saved.cursor('local')).toEqual(new Date(SECOND));
    expect(await saved.cursor('drive')).toEqual(new Date(THIRD));
  });

  it('uses the cursor on the next run and reads only new files', async () => {
    const local = new FakeFileSource('local').add(entry({ id: 'a.md', modifiedAt: FIRST }), 'first');
    const { ctx, kv } = createTestContext({ capabilities: sources(local) });
    const index = new FileIndex(kv);

    await runFileIndex(ctx, index);
    expect(local.listCalls[0]?.modifiedAfter).toBeUndefined();
    expect(local.readCalls).toHaveLength(1);

    await runFileIndex(ctx, index);
    expect(local.listCalls[1]?.modifiedAfter).toEqual(new Date(FIRST));
    expect(local.readCalls).toHaveLength(1);

    local.add(entry({ id: 'new.md', modifiedAt: SECOND }), 'new text');
    await runFileIndex(ctx, index);
    expect(local.readCalls.map((call) => call.id)).toEqual(['a.md', 'new.md']);
  });

  it('skips a file whose modifiedAt already matches the cursor', async () => {
    const files = [entry({ id: 'stuck.md', modifiedAt: FIRST })];
    const reads: string[] = [];
    const source: FileSource = {
      label: 'local',
      list: async () => files,
      readText: async (id) => {
        reads.push(id);
        return 'text';
      },
    };
    const { ctx, kv } = createTestContext({ capabilities: sources(source) });
    const index = new FileIndex(kv);

    await runFileIndex(ctx, index);
    await runFileIndex(ctx, index);

    expect(reads).toEqual(['stuck.md']);
  });

  it('keeps indexing the other source when one fails', async () => {
    const local = new FakeFileSource('local').add(entry({ id: 'a.md', modifiedAt: FIRST }), 'good text');
    local.failList = new Error('boom');
    const drive = new FakeFileSource('drive').add(entry({ id: 'd1', modifiedAt: SECOND }), 'drive text');
    const { ctx, kv } = createTestContext({ capabilities: sources(local, drive) });

    await runFileIndex(ctx, new FileIndex(kv));

    expect((await new FileIndex(kv).search('good', 5))).toEqual([]);
    expect((await new FileIndex(kv).search('drive', 5)).map((hit) => hit.doc.id)).toEqual(['d1']);
  });

  it('skips a file that cannot be read and still saves the rest', async () => {
    const local = new FakeFileSource('local')
      .add(entry({ id: 'bad.md', modifiedAt: FIRST }), 'bad')
      .add(entry({ id: 'good.md', modifiedAt: SECOND }), 'good');
    local.failReads.add('bad.md');
    const { ctx, kv } = createTestContext({ capabilities: sources(local) });

    await runFileIndex(ctx, new FileIndex(kv));

    const saved = new FileIndex(kv);
    expect(await saved.get('local', 'bad.md')).toBeUndefined();
    expect(await saved.get('local', 'good.md')).toBeDefined();
  });

  it('does nothing when no file source is connected', async () => {
    const { ctx, kv } = createTestContext();

    await expect(runFileIndex(ctx, new FileIndex(kv))).resolves.toBeUndefined();
  });
});

describe('files.index job: bursts and deletions', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 10, 17, 0, minute)).toISOString();

  it('walks a burst bigger than one batch oldest first, so no older change is skipped', async () => {
    const local = new FakeFileSource('local').add(entry({ id: 'seed.md', modifiedAt: at(0) }), 'seed');
    const { ctx, kv } = createTestContext({ capabilities: sources(local) });
    const index = new FileIndex(kv);
    await runFileIndex(ctx, index);

    for (let n = 1; n <= 450; n += 1) local.add(entry({ id: `burst-${n}.md`, modifiedAt: at(n) }), `burst word${n}`);
    await runFileIndex(ctx, index);

    expect(await index.docs('local')).toHaveLength(451);
    expect(local.listCalls.every((call) => call.oldestFirst === true)).toBe(true);
    expect(await index.cursor('local')).toEqual(new Date(at(450)));
    // the oldest files of the burst, which a newest-first cap would have dropped
    expect(await index.get('local', 'burst-1.md')).toBeDefined();
  });

  it('lists ties at a full batch boundary again instead of skipping them', async () => {
    const local = new FakeFileSource('local');
    for (let n = 0; n < 205; n += 1) local.add(entry({ id: `same-${String(n).padStart(3, '0')}.md`, modifiedAt: at(5) }), 'same');
    const { ctx, kv } = createTestContext({ capabilities: sources(local) });
    const index = new FileIndex(kv);

    await runFileIndex(ctx, index);

    expect(await index.docs('local')).toHaveLength(205);
  });

  it('removes deleted files from the index and logs them, but keeps files of an unreachable folder', async () => {
    const local = new FakeFileSource('local')
      .add(entry({ id: '/home/me/Documents/a.md', path: 'Documents/a.md', modifiedAt: at(1) }), 'alpha words')
      .add(entry({ id: '/home/me/Documents/b.md', path: 'Documents/b.md', modifiedAt: at(2) }), 'beta words')
      .add(entry({ id: '/Volumes/usb/c.md', path: 'usb/c.md', modifiedAt: at(3) }), 'gamma words');
    const { ctx, kv } = createTestContext({ capabilities: sources(local) });
    const index = new FileIndex(kv);
    const recorded: { source: string; kinds: string[]; ids: string[] }[] = [];
    const sink = {
      record: async (source: string, changes: readonly { id: string; kind: string }[]) => {
        recorded.push({ source, kinds: changes.map((change) => change.kind), ids: changes.map((change) => change.id) });
      },
    };
    await runFileIndex(ctx, index, sink);
    expect(recorded).toEqual([]);

    local.remove('/home/me/Documents/a.md').remove('/Volumes/usb/c.md');
    local.unreachable.add('/Volumes/usb/c.md');
    await runFileIndex(ctx, index, sink);

    expect(await index.get('local', '/home/me/Documents/a.md')).toBeUndefined();
    expect(await index.search('alpha', 5)).toEqual([]);
    expect(await index.get('local', '/Volumes/usb/c.md')).toBeDefined();
    expect(recorded).toEqual([{ source: 'local', kinds: ['removed'], ids: ['/home/me/Documents/a.md'] }]);

    local.add(entry({ id: '/home/me/Documents/b.md', path: 'Documents/b.md', modifiedAt: at(9) }), 'beta changed');
    local.add(entry({ id: '/home/me/Documents/n.md', path: 'Documents/n.md', modifiedAt: at(10) }), 'new');
    await runFileIndex(ctx, index, sink);
    expect(recorded.at(-1)).toEqual({
      source: 'local',
      kinds: ['changed', 'added'],
      ids: ['/home/me/Documents/b.md', '/home/me/Documents/n.md'],
    });
  });
});
