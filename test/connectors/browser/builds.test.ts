import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installLocations, missingChromiumBuilds } from '../../../src/connectors/browser/builds.js';

describe('missingChromiumBuilds', () => {
  it('lists the exact builds Playwright names that are not on disk, so an older cached build does not count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axk-pw-'));
    await mkdir(join(dir, 'chromium-1255'));
    await mkdir(join(dir, 'chromium_headless_shell-1243'));
    const output = `Chrome (playwright chromium v1255)\n  Install location:    ${join(dir, 'chromium-1255')}\n\nChrome Headless Shell (v1255)\n  Install location:    ${join(dir, 'chromium_headless_shell-1255')}\n`;
    expect(installLocations(output)).toHaveLength(2);
    const missing = await missingChromiumBuilds(async () => ({ code: 0, stdout: output, stderr: '', timedOut: false }));
    expect(missing).toEqual([join(dir, 'chromium_headless_shell-1255')]);
    expect(await missingChromiumBuilds(async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }))).toBeUndefined();
  });
});
