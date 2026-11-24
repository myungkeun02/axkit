import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { runFileIndex } from '../../../src/skills/files/index-job.js';
import { FileSources, sourcesOf } from '../../../src/skills/files/sources.js';
import { FileIndex } from '../../../src/skills/files/store.js';
import { createTestContext } from '../../support/context.js';
import { FakeFileSource, entry } from './helpers.js';

const FIRST = '2026-11-17T01:00:00.000Z';
const SECOND = '2026-11-17T02:00:00.000Z';

describe('files.index read retries', () => {
  it('reads a file again on a later run after its read failed, though the cursor moved past it', async () => {
    const local = new FakeFileSource('local')
      .add(entry({ id: 'locked.md', modifiedAt: FIRST }), 'locked words')
      .add(entry({ id: 'open.md', modifiedAt: SECOND }), 'open words');
    local.failReads.add('locked.md');
    const { ctx, kv } = createTestContext({ capabilities: { [Contracts.filesLocal.id]: local } });
    const index = new FileIndex(kv);

    await runFileIndex(ctx, index);
    expect(await index.cursor('local')).toEqual(new Date(SECOND));
    expect(await kv.get('retry:local')).toMatchObject([{ entry: { id: 'locked.md' }, tries: 1 }]);

    local.failReads.delete('locked.md');
    await runFileIndex(ctx, index);
    expect((await index.search('locked', 5)).map((hit) => hit.doc.id)).toEqual(['locked.md']);
    expect(await kv.get('retry:local')).toBeUndefined();
  });

  it('gives up on a file that keeps failing after five tries', async () => {
    const local = new FakeFileSource('local').add(entry({ id: 'bad.md', modifiedAt: FIRST }), 'x');
    local.failReads.add('bad.md');
    const { ctx, kv } = createTestContext({ capabilities: { [Contracts.filesLocal.id]: local } });
    const index = new FileIndex(kv);
    for (let run = 0; run < 5; run += 1) await runFileIndex(ctx, index);
    expect(local.readCalls).toHaveLength(5);
    expect(await kv.get('retry:local')).toBeUndefined();
    await runFileIndex(ctx, index);
    expect(local.readCalls).toHaveLength(5);
  });
});

describe('file source registry', () => {
  it('lists local and Drive first, then sources connectors registered, and indexes them all', async () => {
    const local = new FakeFileSource('local').add(entry({ id: 'a.md', modifiedAt: FIRST }), 'local words');
    const drive = new FakeFileSource('drive').add(entry({ id: 'd1', modifiedAt: FIRST }), 'drive words');
    const notes = new FakeFileSource('notion').add(entry({ id: 'n1', modifiedAt: SECOND }), 'notion words');
    const test = createTestContext({ capabilities: { [Contracts.filesLocal.id]: local, [Contracts.filesDrive.id]: drive } });
    expect(sourcesOf(test.ctx).map((source) => source.label)).toEqual(['local', 'drive']);

    const registry = new FileSources(test.ctx);
    test.provided.set(Contracts.fileSources.id, registry);
    registry.register(notes);
    registry.register(new FakeFileSource('local'));
    expect(sourcesOf(test.ctx).map((source) => source.label)).toEqual(['local', 'drive', 'notion']);

    const index = new FileIndex(test.kv);
    await runFileIndex(test.ctx, index);
    expect((await index.search('notion', 5)).map((hit) => hit.doc.source)).toEqual(['notion']);
  });
});
