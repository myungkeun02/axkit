import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../../src/core/log/console-logger.js';
import type { ProcessRunner } from '../../src/core/process/types.js';
import type { RunningSource } from '../../src/app/source/start.js';
import { startSourceServer } from '../../src/app/source/start.js';
import { SourceTokens } from '../../src/app/source/tokens.js';

export interface SourceFixture {
  /** The work Mac's pretend home. */
  home: string;
  sourceHome: string;
  url: string;
  running: RunningSource;
  tokens: SourceTokens;
  /** A fresh pairing code. */
  code(): Promise<string>;
  close(): Promise<void>;
}

/**
 * A pretend work Mac: ~/Documents (shared, with notes, a secret-looking file and a brand folder of docs),
 * ~/dev/app (shared git repo with an origin), ~/Private (not shared), served on 127.0.0.1 with a free port.
 */
export async function startSourceFixture(opts: { perMinute?: number; run?: ProcessRunner; sessions?: boolean } = {}): Promise<SourceFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ax-source-')));
  const home = join(root, 'home');
  const sourceHome = join(root, 'source');
  await mkdir(join(home, 'Documents', 'Brand', 'v1'), { recursive: true });
  await mkdir(join(home, 'dev', 'app', '.git'), { recursive: true });
  await mkdir(join(home, 'Private'), { recursive: true });
  await writeFile(join(home, 'Documents', 'notes.md'), '# 회의 메모\n신제품 출시 계획');
  await writeFile(join(home, 'Documents', 'passwords.txt'), 'hunter2');
  await writeFile(join(home, 'Documents', '.env'), 'KEY=1');
  for (let index = 0; index < 6; index += 1) await writeFile(join(home, 'Documents', 'Brand', 'v1', `draft-${index}.md`), `시안 ${index}`);
  await writeFile(join(home, 'dev', 'app', 'README.md'), '# App');
  await writeFile(join(home, 'dev', 'app', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
  await writeFile(join(home, 'dev', 'app', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(home, 'Private', 'diary.md'), 'private');
  // One Claude Code session in ~/dev/app.
  const cwd = join(home, 'dev', 'app');
  const line = (type: string, text: string, at: string): string => JSON.stringify({ type, cwd, timestamp: at, sessionId: 's1', message: { role: type, content: text } });
  await mkdir(join(home, '.claude', 'projects', '-dev-app'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'projects', '-dev-app', 's1.jsonl'),
    [line('user', '로그인 화면 고쳐줘', '2026-11-20T09:00:00.000Z'), line('assistant', '고쳤어요.', '2026-11-20T09:05:00.000Z')].join('\n') + '\n',
  );
  const run: ProcessRunner =
    opts.run ??
    (async (cmd) => ({ code: cmd === 'git' ? 1 : 0, stdout: '', stderr: '', timedOut: false }));
  const running = await startSourceServer({
    config: { folders: ['~/Documents', '~/dev'], sessions: opts.sessions ?? true, port: 0 },
    sourceHome,
    hosts: ['127.0.0.1'],
    log: silentLogger,
    port: 0,
    home,
    run,
    host: 'Theos-MacBook-Pro',
    ...(opts.perMinute !== undefined ? { perMinute: opts.perMinute } : {}),
  });
  const address = running.servers[0]?.address() as AddressInfo;
  const tokens = new SourceTokens({ dir: sourceHome });
  return {
    home,
    sourceHome,
    url: `http://127.0.0.1:${address.port}`,
    running,
    tokens,
    code: () => tokens.startPairing(),
    close: async () => {
      await running.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
