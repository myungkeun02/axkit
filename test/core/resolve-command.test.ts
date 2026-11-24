import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCommand } from '../../src/core/process/resolve-command.js';

describe('finding a CLI the login service cannot see', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ax-cmd-'));
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(join(home, '.local', 'bin', 'claude-test-cli'), '#!/bin/sh\n');
    await chmod(join(home, '.local', 'bin', 'claude-test-cli'), 0o755);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('looks in ~/.local/bin when PATH is the short launchd one', () => {
    expect(resolveCommand('claude-test-cli', { PATH: '/usr/bin:/bin' }, home)).toBe(join(home, '.local', 'bin', 'claude-test-cli'));
    expect(resolveCommand('no-such-cli-xyz', { PATH: '/usr/bin:/bin' }, home)).toBeUndefined();
    expect(resolveCommand('/bin/sh', {}, home)).toBe('/bin/sh');
  });
});
