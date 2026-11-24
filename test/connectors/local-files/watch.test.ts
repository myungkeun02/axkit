import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeLocalFs } from '../../../src/connectors/local-files/fs.js';
import { LocalFilesSource } from '../../../src/connectors/local-files/source.js';
import type { WatchFactory } from '../../../src/connectors/local-files/watch.js';
import type { FileChange } from '../../../src/core/contracts/files.js';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import { FakeLocalFs, captureLogger } from './helpers.js';

const HOME = '/home/me';
const DOCS = '/home/me/Documents';

interface FakeWatcher {
  factory: WatchFactory;
  emit(dir: string, filename: string | undefined): void;
  error(dir: string): void;
  closed: string[];
}

function fakeWatcher(failFor: string[] = []): FakeWatcher {
  const listeners = new Map<string, { onEvent: (name: string | undefined) => void; onError: (error: unknown) => void }>();
  const closed: string[] = [];
  return {
    closed,
    factory: (dir, onEvent, onError) => {
      if (failFor.includes(dir)) throw new Error('EMFILE');
      listeners.set(dir, { onEvent, onError });
      return { close: () => closed.push(dir) };
    },
    emit: (dir, filename) => listeners.get(dir)?.onEvent(filename),
    error: (dir) => listeners.get(dir)?.onError(new Error('boom')),
  };
}

function source(fs: FakeLocalFs, watcher: FakeWatcher, folders = [DOCS]) {
  const log = captureLogger();
  return {
    log,
    source: new LocalFilesSource({
      fs,
      folders,
      rules: DEFAULT_FILE_RULES,
      includeHidden: false,
      home: HOME,
      log,
      watchFactory: watcher.factory,
      debounceMs: 5,
    }),
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met');
    await wait(10);
  }
}

describe('LocalFilesSource.watch', () => {
  it('debounces a burst into one batch and skips hidden and secret-looking paths', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/a.md`, 'a', 1_000).addFile(`${DOCS}/notes/b.md`, 'b', 2_000);
    const watcher = fakeWatcher();
    const { source: local } = source(fs, watcher);
    const batches: (readonly FileChange[])[] = [];
    const handle = await local.watch((changes) => {
      batches.push(changes);
    });

    watcher.emit(DOCS, 'a.md');
    watcher.emit(DOCS, 'a.md');
    watcher.emit(DOCS, 'notes/b.md');
    watcher.emit(DOCS, '.git/index');
    watcher.emit(DOCS, 'notes/.DS_Store');
    watcher.emit(DOCS, 'password-list.md');
    watcher.emit(DOCS, undefined);
    watcher.emit(DOCS, 'gone.md');
    await waitFor(() => batches.length > 0);
    await wait(20);

    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch?.map((change) => [change.id, change.entry?.path])).toEqual([
      [`${DOCS}/a.md`, 'Documents/a.md'],
      [`${DOCS}/notes/b.md`, 'Documents/notes/b.md'],
      [`${DOCS}/gone.md`, undefined],
    ]);
    handle.close();
    expect(watcher.closed).toEqual([DOCS]);
  });

  it('lists the files of a folder that was moved in', async () => {
    const fs = new FakeLocalFs()
      .addDir(DOCS)
      .addFile(`${DOCS}/moved/x.md`, 'x', 1_000)
      .addFile(`${DOCS}/moved/deep/y.txt`, 'y', 2_000)
      .addFile(`${DOCS}/moved/z.png`, 'z', 3_000);
    const watcher = fakeWatcher();
    const { source: local } = source(fs, watcher);
    const batches: (readonly FileChange[])[] = [];
    const handle = await local.watch((changes) => {
      batches.push(changes);
    });

    watcher.emit(DOCS, 'moved');
    await waitFor(() => batches.length > 0);

    expect(batches[0]?.map((change) => change.entry?.path).sort()).toEqual(['Documents/moved/deep/y.txt', 'Documents/moved/x.md']);
    handle.close();
  });

  it('rejects when no folder can be watched and warns once on watcher errors', async () => {
    const fs = new FakeLocalFs().addDir(DOCS).addDir(`${HOME}/Notes`);
    const failing = fakeWatcher([DOCS]);
    await expect(source(fs, failing).source.watch(() => undefined)).rejects.toThrow('No configured folder could be watched.');

    const partly = fakeWatcher([DOCS]);
    const { source: local, log } = source(fs, partly, [DOCS, `${HOME}/Notes`]);
    const handle = await local.watch(() => undefined);
    partly.error(`${HOME}/Notes`);
    partly.error(`${HOME}/Notes`);
    expect(log.warnings.filter((line) => line.includes('watching a folder failed'))).toHaveLength(1);
    handle.close();
  });

  it('tells a gone file from one whose folder is unreachable', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/a.md`, 'a', 1_000);
    const { source: local } = source(fs, fakeWatcher(), [DOCS, '/Volumes/usb']);
    expect(await local.entry(`${DOCS}/a.md`)).toMatchObject({ path: 'Documents/a.md' });
    expect(await local.entry(`${DOCS}/missing.md`)).toBeUndefined();
    await expect(local.entry('/Volumes/usb/c.md')).rejects.toThrow('not reachable');
  });

  it('lists oldest first when asked', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/new.md`, 'n', 2_000).addFile(`${DOCS}/old.md`, 'o', 1_000);
    const { source: local } = source(fs, fakeWatcher());
    expect((await local.list({ limit: 10, oldestFirst: true })).map((entry) => entry.name)).toEqual(['old.md', 'new.md']);
    expect((await local.list({ limit: 10 })).map((entry) => entry.name)).toEqual(['new.md', 'old.md']);
  });
});

describe('LocalFilesSource.watch with real fs.watch', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reports a new file and a removed one in a temp folder', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'axkit-watch-')));
    dirs.push(home);
    const docs = join(home, 'Documents');
    await mkdir(join(docs, 'sub'), { recursive: true });
    await writeFile(join(docs, 'keep.md'), 'keep');
    const local = new LocalFilesSource({
      fs: nodeLocalFs,
      folders: [docs],
      rules: DEFAULT_FILE_RULES,
      includeHidden: false,
      home,
      log: captureLogger(),
      debounceMs: 50,
    });
    const changes: FileChange[] = [];
    const handle = await local.watch((batch) => {
      changes.push(...batch);
    });
    try {
      await wait(100);
      await writeFile(join(docs, 'sub', 'new.md'), 'hello');
      await waitFor(() => changes.some((change) => change.entry?.path === 'Documents/sub/new.md'), 8_000);
      await rm(join(docs, 'keep.md'));
      await waitFor(() => changes.some((change) => change.id === join(docs, 'keep.md') && change.entry === undefined), 8_000);
    } finally {
      handle.close();
    }
  }, 20_000);
});
