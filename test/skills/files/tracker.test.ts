import { describe, expect, it } from 'vitest';
import type { AppView } from '../../../src/core/contracts/device-api.js';
import type { FileChange, FileWatch, FilesChanged } from '../../../src/core/contracts/files.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { ChangeLog, MAX_CHANGES, inFolder } from '../../../src/skills/files/changes.js';
import { filesSkill } from '../../../src/skills/files/plugin.js';
import type { FileTracker } from '../../../src/skills/files/tracker.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';
import { FakeFileSource, entry } from './helpers.js';

const HOME = '/home/me';
const DOCS = `${HOME}/Documents`;

class WatchingSource extends FakeFileSource {
  listener: ((changes: readonly FileChange[]) => void | Promise<void>) | undefined;
  failWatch = false;
  closed = false;

  async watch(listener: (changes: readonly FileChange[]) => void | Promise<void>): Promise<FileWatch> {
    if (this.failWatch) throw new Error('no watch');
    this.listener = listener;
    return {
      close: () => {
        this.closed = true;
      },
    };
  }
}

async function setup(source: WatchingSource, now = new Date('2026-11-19T03:00:00.000Z')) {
  const views: AppView[] = [];
  const features: string[] = [];
  const registry = { register: (view: AppView) => views.push(view), addFeature: (name: string) => features.push(name) };
  const context = createTestContext({
    now,
    assistant: { timezone: 'Asia/Seoul' },
    capabilities: { [Contracts.filesLocal.id]: source, [Contracts.appViews.id]: registry },
  });
  let tracker: FileTracker | undefined;
  const instance = await filesSkill({ home: HOME, onTracker: (made) => (tracker = made) }).setup(context.ctx);
  const events: FilesChanged[] = [];
  context.ctx.bus.on('files.changed', (payload) => {
    events.push(payload);
  });
  if (tracker === undefined || instance === undefined) throw new Error('no tracker');
  return { ...context, tracker, instance, views, features, events };
}

describe('watched file changes', () => {
  it('reindexes only the changed files, logs them home-relative and emits files.changed', async () => {
    const source = new WatchingSource('local').add(
      entry({ id: `${DOCS}/a.md`, path: 'Documents/a.md', modifiedAt: '2026-11-18T01:00:00.000Z' }),
      'alpha',
    );
    const { ctx, tracker, instance, events, scheduler } = await setup(source);
    await scheduler.run('files.index');
    await instance.start?.();
    expect(tracker.watching).toBe(true);

    const changed = entry({ id: `${DOCS}/a.md`, path: 'Documents/a.md', modifiedAt: '2026-11-19T01:00:00.000Z' });
    const added = entry({ id: `${DOCS}/notes/b.md`, path: 'Documents/notes/b.md', modifiedAt: '2026-11-19T01:00:00.000Z' });
    source.add(changed, 'alpha changed').add(added, 'brand new words');
    await source.listener?.([
      { id: changed.id, entry: changed },
      { id: added.id, entry: added },
    ]);
    await tracker.idle();
    expect(source.readCalls.map((call) => call.id)).toEqual([`${DOCS}/a.md`, `${DOCS}/a.md`, `${DOCS}/notes/b.md`]);

    source.remove(added.id);
    await source.listener?.([{ id: `${DOCS}/notes` }]);
    await tracker.idle();

    expect(events.map((event) => event.changes.map((change) => `${change.kind} ${change.path}`))).toEqual([
      ['changed ~/Documents/a.md', 'added ~/Documents/notes/b.md'],
      ['removed ~/Documents/notes/b.md'],
    ]);
    const outcome = await ctx.tools.execute('files.changes', { since_hours: 48, folder: 'notes' });
    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') {
      expect(outcome.output).toMatchObject({
        total: 2,
        watching: true,
        changes: [
          { kind: 'removed', path: '~/Documents/notes/b.md', name: 'b.md', at: '2026-11-19 12:00' },
          { kind: 'added', path: '~/Documents/notes/b.md' },
        ],
      });
    }
    await instance.stop?.();
    expect(source.closed).toBe(true);
  });

  it('keeps the hourly poll and says so when watching fails', async () => {
    const source = new WatchingSource('local');
    source.failWatch = true;
    const { tracker, instance, ctx, views, features } = await setup(source);
    await instance.start?.();
    await instance.start?.();
    expect(tracker.watching).toBe(false);
    expect(ctx.log).toBeDefined();

    await ctx.bus.emit('app.started', { at: new Date() });
    expect(features).toEqual(['file-changes']);
    const view = views.find((item) => item.name === 'file-changes');
    const body = (await view?.read(new URLSearchParams())) as { blocks: { kind: string; text?: string }[] };
    expect(body.blocks.map((block) => block.kind)).toEqual(['stat', 'text', 'note', 'note', 'ask']);
    expect(body.blocks[2]?.text).toContain('한 시간마다');
  });

  it('draws the view grouped by day in plain Korean', async () => {
    const source = new WatchingSource('local');
    const { views, kv, ctx } = await setup(source, new Date('2026-11-19T03:00:00.000Z'));
    const log = new ChangeLog(kv);
    await log.add([
      { path: '~/Documents/old.md', kind: 'changed', at: '2026-11-16T05:00:00.000Z' },
      { path: '~/Documents/y.md', kind: 'removed', at: '2026-11-18T05:00:00.000Z' },
      { path: '~/Documents/t.md', kind: 'added', at: '2026-11-19T01:30:00.000Z' },
    ]);
    await ctx.bus.emit('app.started', { at: new Date() });
    const view = views.find((item) => item.name === 'file-changes');
    expect(view).toMatchObject({ ui: 'blocks', title: '파일 변경', version: 1 });
    const body = (await view?.read(new URLSearchParams())) as {
      blocks: { kind: string; title?: string; value?: string; rows?: { title: string; detail?: string; trailing?: string }[] }[];
    };
    expect(body.blocks[0]).toEqual({ kind: 'stat', title: '최근 7일 동안 바뀐 파일', value: '3건' });
    const lists = body.blocks.filter((block) => block.kind === 'list');
    expect(lists.map((block) => block.title)).toEqual(['오늘 · 1건', '어제 · 1건', '11월 16일 (월) · 1건']);
    expect(lists[0]?.rows).toEqual([{ title: 't.md', detail: '새로 생김 · ~/Documents', trailing: '10:30' }]);
    expect(lists[1]?.rows?.[0]?.detail).toBe('지워짐 · ~/Documents');
  });
});

describe('change log', () => {
  it('keeps the last 500 and filters by folder', async () => {
    const log = new ChangeLog(new MapKeyValueStore());
    const records = Array.from({ length: MAX_CHANGES + 20 }, (_, n) => ({
      path: `~/Documents/f${n}.md`,
      kind: 'added' as const,
      at: new Date(Date.UTC(2026, 10, 19, 0, 0, n)).toISOString(),
    }));
    await log.add(records.slice(0, 300));
    await log.add(records.slice(300));
    const all = await log.all();
    expect(all).toHaveLength(MAX_CHANGES);
    expect(all[0]?.path).toBe('~/Documents/f20.md');
    expect((await log.since(new Date(0)))[0]?.path).toBe(`~/Documents/f${MAX_CHANGES + 19}.md`);

    expect(inFolder('~/Documents/notes/a.md', '~/Documents')).toBe(true);
    expect(inFolder('~/Documents/notes/a.md', 'notes')).toBe(true);
    expect(inFolder('~/Documents/notes/a.md', 'Desktop')).toBe(false);
    expect(inFolder('~/Documents/notesx/a.md', 'notes')).toBe(false);
  });
});
