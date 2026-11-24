import { describe, expect, it } from 'vitest';
import { localFilesConnector } from '../../../src/connectors/local-files/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { FakeLocalFs } from './helpers.js';

const HOME = '/home/me';
const DOCS = '/home/me/Documents';

async function setup(options: TestContextOptions = {}, fs = new FakeLocalFs()) {
  const context = createTestContext(options);
  await localFilesConnector({ fs, home: HOME }).setup(context.ctx);
  return context;
}

describe('localFilesConnector', () => {
  it('provides the local file capability and expands ~', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello', 1_000);
    const { ctx } = await setup({ config: { folders: ['~/Documents'] } }, fs);

    const source = ctx.use(Contracts.filesLocal);
    expect(source.label).toBe('local');
    const listed = await source.list({ limit: 5 });
    expect(listed.map((entry) => entry.path)).toEqual(['Documents/note.md']);
    await expect(source.readText(listed[0]!.id, 100)).resolves.toBe('hello');
  });

  it('declares the connector identity', async () => {
    const plugin = localFilesConnector();
    expect(plugin.manifest).toMatchObject({ id: 'connector.local-files', kind: 'connector', title: 'Local folders' });
  });

  it('provides a source that lists nothing when no folder is configured', async () => {
    const { ctx } = await setup();

    await expect(ctx.use(Contracts.filesLocal).list({ limit: 10 })).resolves.toEqual([]);
  });

  it('falls back to nothing on invalid config', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello', 1_000);
    const { ctx } = await setup({ config: { folders: 'not-an-array' } }, fs);

    await expect(ctx.use(Contracts.filesLocal).list({ limit: 10 })).resolves.toEqual([]);
  });
});
