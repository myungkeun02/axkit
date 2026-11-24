import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEYSTORE_SECRET, androidPaths, ensureSigningKey } from '../../src/app/android.js';
import type { ProcessRunner, RunOptions } from '../../src/core/process/types.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('android signing key', () => {
  it('creates the key once with the password only in the environment and the Keychain', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axkit-android-'));
    homes.push(home);
    const calls: { args: readonly string[]; opts: RunOptions }[] = [];
    const run: ProcessRunner = async (_cmd, args, opts) => {
      calls.push({ args, opts });
      await writeFile(androidPaths(home).keystore, 'ks');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    const secrets = new MemorySecretStore();
    expect(await ensureSigningKey({ home, secrets, run })).toBe('created');
    const password = await secrets.get(KEYSTORE_SECRET);
    expect(password?.length).toBeGreaterThan(20);
    expect(calls[0]?.args.join(' ')).not.toContain(password!);
    expect(calls[0]?.opts.env?.['AXKIT_KS_PASS']).toBe(password);
    expect(await ensureSigningKey({ home, secrets, run })).toBe('exists');
    expect(calls).toHaveLength(1);
  });

  it('refuses to overwrite a keystore whose password is lost', async () => {
    const home = await mkdtemp(join(tmpdir(), 'axkit-android-'));
    homes.push(home);
    const run: ProcessRunner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(home, 'android'), { recursive: true });
    await writeFile(androidPaths(home).keystore, 'ks');
    await expect(ensureSigningKey({ home, secrets: new MemorySecretStore(), run })).rejects.toThrow(/password is missing/);
  });
});
