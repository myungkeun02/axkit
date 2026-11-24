import { describe, expect, it } from 'vitest';
import { folderScanConnector } from '../../../src/connectors/local-files/scan-plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ProcessRunner, RunResult } from '../../../src/core/process/types.js';
import { createTestContext } from '../../support/context.js';
import { FakeLocalFs } from './helpers.js';

const HOME = '/home/me';
const DOCS = '/home/me/Documents';

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

describe('folderScanConnector', () => {
  it('declares the connector identity without required capabilities', async () => {
    const plugin = folderScanConnector();

    expect(plugin.manifest).toMatchObject({
      id: 'connector.folder-scan',
      kind: 'connector',
      title: 'Folder scan (first look)',
    });
    expect(plugin.manifest.needs).toBeUndefined();
  });

  it('provides the files.scan capability and walks the folders the owner picked', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello', 1_000);
    const run: ProcessRunner = async () => ok();
    const { ctx, provided } = createTestContext({ config: { folders: ['~/Documents'] } });

    await folderScanConnector({ fs, home: HOME, run }).setup(ctx);

    expect(provided.has('files.scan')).toBe(true);
    const scan = ctx.use(Contracts.folderScan).open(['~/Documents']);
    const result = await scan.walk();
    expect(result.files.map((file) => file.path)).toEqual(['~/Documents/note.md']);
    await expect(scan.excerpt(result.files[0]!.id, 100)).resolves.toBe('hello');
  });

  it('reads the file rules from config', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello', 1_000);
    const { ctx } = createTestContext({ config: { extensions: ['txt'] } });

    await folderScanConnector({ fs, home: HOME }).setup(ctx);

    const scan = ctx.use(Contracts.folderScan).open(['~/Documents']);
    const result = await scan.walk();
    expect(result.files[0]?.readable).toBe(false);
  });
});
