import { describe, expect, it, vi } from 'vitest';
import type { ExecFn } from '../../src/core/secrets/keychain.js';
import { KeychainSecretStore } from '../../src/core/secrets/keychain.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { scopedReader } from '../../src/core/secrets/scoped.js';

interface Call {
  cmd: string;
  args: string[];
  input: string | undefined;
}

function fakeExec(
  results: { code: number; stdout: string; stderr: string },
): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    return results;
  };
  return { exec, calls };
}

describe('KeychainSecretStore', () => {
  it('reads a secret without putting it on the command line', async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: 'token-value\n', stderr: '' });
    const store = new KeychainSecretStore({ exec });

    expect(await store.get('discord.bot-token')).toBe('token-value');
    expect(calls[0]?.cmd).toBe('security');
    expect(calls[0]?.args).toEqual(['find-generic-password', '-s', 'ax-kit', '-a', 'discord.bot-token', '-w']);
    expect(calls[0]?.args.join(' ')).not.toContain('token-value');
  });

  it('treats exit code 44 as absent', async () => {
    const { exec } = fakeExec({ code: 44, stdout: '', stderr: '' });
    const store = new KeychainSecretStore({ exec });
    expect(await store.get('llm.key')).toBeUndefined();
    expect(await store.has('llm.key')).toBe(false);
  });

  it('throws on other lookup failures', async () => {
    const { exec } = fakeExec({ code: 1, stdout: '', stderr: 'denied' });
    const store = new KeychainSecretStore({ exec });
    await expect(store.get('llm.key')).rejects.toThrow(/exited 1/);
  });

  it('writes through stdin with correct quoting, never in argv', async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: '', stderr: '' });
    const store = new KeychainSecretStore({ exec, service: 'ax-kit-test' });

    await store.set('discord.bot-token', 'a"b\\c');

    const call = calls.at(-1);
    expect(call?.cmd).toBe('security');
    expect(call?.args).toEqual(['-i']);
    expect(call?.input).toBe(
      `add-generic-password -U -s "ax-kit-test" -a "discord.bot-token" -w "a\\"b\\\\c"\n`,
    );
    expect(call?.args.join('\0')).not.toContain('a"b');
  });

  it('rejects values with line breaks or NUL characters', async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: '', stderr: '' });
    const store = new KeychainSecretStore({ exec });

    await expect(store.set('llm.key', 'a\nb')).rejects.toThrow(/line breaks/);
    await expect(store.set('llm.key', 'a\0b')).rejects.toThrow(/line breaks/);
    expect(calls).toHaveLength(0);
  });

  it('accepts exit code 44 on delete', async () => {
    const missing = fakeExec({ code: 44, stdout: '', stderr: '' });
    await expect(new KeychainSecretStore({ exec: missing.exec }).delete('llm.key')).resolves.toBeUndefined();

    const failing = fakeExec({ code: 1, stdout: '', stderr: '' });
    await expect(new KeychainSecretStore({ exec: failing.exec }).delete('llm.key')).rejects.toThrow(/exited 1/);
  });

  it('validates secret names', async () => {
    const { exec } = fakeExec({ code: 0, stdout: '', stderr: '' });
    const store = new KeychainSecretStore({ exec });
    await expect(store.get('Bad Name')).rejects.toThrow(/Invalid secret name/);
    await expect(store.set('-bad', 'x')).rejects.toThrow(/Invalid secret name/);
  });
});

describe('MemorySecretStore', () => {
  it('stores, reads and deletes values', async () => {
    const store = new MemorySecretStore({ 'a.b': 'one' });
    expect(await store.has('a.b')).toBe(true);
    expect(await store.get('a.b')).toBe('one');
    await store.set('c.d', 'two');
    expect(await store.get('c.d')).toBe('two');
    await store.delete('a.b');
    expect(await store.get('a.b')).toBeUndefined();
  });
});

describe('scopedReader', () => {
  it('allows listed names and rejects others', async () => {
    const base = new MemorySecretStore({ 'a.b': 'value', 'c.d': 'other' });
    const reader = scopedReader(base, ['a.b'], 'skill.demo');

    expect(await reader.get('a.b')).toBe('value');
    await expect(reader.get('c.d')).rejects.toThrow(/skill\.demo.*c\.d/);
  });

  it('delegates reads to the underlying store', async () => {
    const base = new MemorySecretStore({ 'a.b': 'value' });
    const get = vi.spyOn(base, 'get');
    const reader = scopedReader(base, ['a.b'], 'owner');
    await reader.get('a.b');
    expect(get).toHaveBeenCalledWith('a.b');
  });
});
