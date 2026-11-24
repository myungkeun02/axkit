import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { z } from 'zod';
import { DEFAULT_CONFIRM_POLICY, needsConfirmation } from '../../src/core/policy/confirm.js';
import type { ConfirmAnswer, ConfirmPolicyConfig, ConfirmRequest, Confirmer } from '../../src/core/policy/types.js';
import { MemoryAuditLog, silentLogger } from '../../src/core/log/console-logger.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { PolicyToolExecutor } from '../../src/core/tools/executor.js';
import type { Tool } from '../../src/core/tools/types.js';

describe('needsConfirmation', () => {
  it('always requires confirmation for send, pay and delete', () => {
    for (const effect of ['send', 'pay', 'delete'] as const) {
      expect(needsConfirmation([effect], { confirmWrites: false, expiresMinutes: 30 })).toBe(true);
    }
  });

  it('requires confirmation for writes only when configured', () => {
    expect(needsConfirmation(['write'], { confirmWrites: false, expiresMinutes: 30 })).toBe(false);
    expect(needsConfirmation(['write'], { confirmWrites: true, expiresMinutes: 30 })).toBe(true);
  });

  it('does not require confirmation for reads', () => {
    expect(needsConfirmation(['read'], { confirmWrites: true, expiresMinutes: 30 })).toBe(false);
    expect(needsConfirmation([], DEFAULT_CONFIRM_POLICY)).toBe(false);
  });
});

describe('InMemoryToolRegistry', () => {
  function tool(name: string): Tool<unknown, unknown> {
    return { name, description: 'x', input: z.unknown(), effects: ['read'], run: async () => undefined };
  }

  it('registers, gets and lists tools', () => {
    const registry = new InMemoryToolRegistry();
    registry.register(tool('notes.search'));
    registry.register(tool('mail.send'));

    expect(registry.get('notes.search')?.name).toBe('notes.search');
    expect(registry.list().map((item) => item.name)).toEqual(['notes.search', 'mail.send']);
  });

  it('rejects duplicates and invalid names', () => {
    const registry = new InMemoryToolRegistry();
    registry.register(tool('notes.search'));
    expect(() => registry.register(tool('notes.search'))).toThrow(/Duplicate/);
    expect(() => registry.register(tool('nodot'))).toThrow(/Invalid tool name/);
    expect(() => registry.register(tool('Bad.Name'))).toThrow(/Invalid tool name/);
  });
});

describe('PolicyToolExecutor', () => {
  const readTool: Tool<{ query: string }, { echo: string }> = {
    name: 'notes.search',
    description: 'Search notes',
    input: z.object({ query: z.string() }),
    effects: ['read'],
    run: async (input) => ({ echo: input.query }),
  };

  const sendTool: Tool<{ to: string; body: string }, { sent: boolean }> = {
    name: 'mail.send',
    description: 'Send mail',
    input: z.object({ to: z.string(), body: z.string() }),
    effects: ['send'],
    describe: (input) => `Send "${input.body}" to ${input.to}`,
    run: async () => ({ sent: true }),
  };

  const inviteTool: Tool<{ to: string; guests: string[] }, { ok: boolean }> = {
    name: 'calendar.create_event',
    description: 'Create event',
    input: z.object({ to: z.string(), guests: z.array(z.string()).default([]) }),
    effects: ['write'],
    effectsFor: (input) => (input.guests.length > 0 ? ['send'] : []),
    describe: (input) => `Create event at ${input.to} with ${input.guests.length} guests`,
    run: async () => ({ ok: true }),
  };

  function setup(
    policy: ConfirmPolicyConfig = DEFAULT_CONFIRM_POLICY,
    answer: ConfirmAnswer | undefined = undefined,
    timeoutMs?: number,
  ): {
    executor: PolicyToolExecutor;
    audit: MemoryAuditLog;
    confirm: Mock<(request: ConfirmRequest) => Promise<ConfirmAnswer>>;
    confirmer: Confirmer | undefined;
  } {
    const registry = new InMemoryToolRegistry();
    registry.register(readTool);
    registry.register(sendTool);
    registry.register(inviteTool);
    const audit = new MemoryAuditLog();
    const confirm = vi.fn<(request: ConfirmRequest) => Promise<ConfirmAnswer>>(
      async () => answer ?? 'denied',
    );
    const confirmer: Confirmer | undefined = answer === undefined && policy === DEFAULT_CONFIRM_POLICY && timeoutMs === undefined
      ? undefined
      : { confirm };
    const executor = new PolicyToolExecutor({
      registry,
      confirmer: () => confirmer,
      policy,
      audit,
      log: silentLogger,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { executor, audit, confirm, confirmer };
  }

  function executorWithNoConfirmer(policy: ConfirmPolicyConfig = DEFAULT_CONFIRM_POLICY): {
    executor: PolicyToolExecutor;
    audit: MemoryAuditLog;
  } {
    const registry = new InMemoryToolRegistry();
    registry.register(readTool);
    registry.register(sendTool);
    registry.register(inviteTool);
    const audit = new MemoryAuditLog();
    return {
      executor: new PolicyToolExecutor({
        registry,
        confirmer: () => undefined,
        policy,
        audit,
        log: silentLogger,
      }),
      audit,
    };
  }

  it('fails unknown tools', async () => {
    const { executor, audit } = executorWithNoConfirmer();
    const outcome = await executor.execute('missing.tool', {});
    expect(outcome).toEqual({ status: 'failed', error: 'Unknown tool: missing.tool' });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.detail).toMatchObject({ status: 'failed' });
  });

  it('rejects invalid input with issues', async () => {
    const { executor, audit } = executorWithNoConfirmer();
    const outcome = await executor.execute('notes.search', { query: 42 });
    expect(outcome.status).toBe('invalid_input');
    if (outcome.status === 'invalid_input') {
      expect(outcome.issues).toHaveLength(1);
      expect(outcome.issues[0]).toMatch(/^query: /);
    }
    expect(audit.entries[0]?.detail).toMatchObject({ status: 'invalid_input' });
  });

  it('runs read tools without confirmation even when writes need it', async () => {
    const { executor, confirm } = setup({ confirmWrites: true, expiresMinutes: 30 }, 'approved');
    const outcome = await executor.execute('notes.search', { query: 'cats' });
    expect(outcome).toEqual({ status: 'done', output: { echo: 'cats' } });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('denies send tools when no confirmer exists', async () => {
    const { executor, audit } = executorWithNoConfirmer();
    const outcome = await executor.execute('mail.send', { to: 'a@b.c', body: 'secret body' });
    expect(outcome).toEqual({ status: 'denied' });
    expect(JSON.stringify(audit.entries)).not.toContain('secret body');
  });

  it('does not run send tools when denied', async () => {
    const { executor, confirm } = setup(DEFAULT_CONFIRM_POLICY, 'denied');
    const outcome = await executor.execute('mail.send', { to: 'a@b.c', body: 'hi' });
    expect(outcome).toEqual({ status: 'denied' });
    expect(confirm).toHaveBeenCalledTimes(1);
    const request = confirm.mock.calls[0]?.[0];
    expect(request?.toolName).toBe('mail.send');
    expect(request?.effects).toEqual(['send']);
    expect(request?.summary).toBe('Send "hi" to a@b.c');
  });

  it('runs send tools when approved and audits without input values', async () => {
    const { executor, confirm, audit } = setup(DEFAULT_CONFIRM_POLICY, 'approved');
    const outcome = await executor.execute('mail.send', { to: 'a@b.c', body: 'private text' });
    expect(outcome).toEqual({ status: 'done', output: { sent: true } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(audit.entries[0]).toMatchObject({
      kind: 'tool',
      subject: 'mail.send',
      detail: { status: 'done', effects: ['send'] },
    });
    expect(JSON.stringify(audit.entries)).not.toContain('private text');
  });

  it('reports expired confirmations as expired', async () => {
    const { executor } = setup(DEFAULT_CONFIRM_POLICY, 'expired');
    const outcome = await executor.execute('mail.send', { to: 'a@b.c', body: 'hi' });
    expect(outcome).toEqual({ status: 'expired' });
  });

  it('escalates effects from effectsFor', async () => {
    const policy: ConfirmPolicyConfig = { confirmWrites: false, expiresMinutes: 30 };
    const withoutGuests = executorWithNoConfirmer(policy);
    expect(await withoutGuests.executor.execute('calendar.create_event', { to: '10:00' })).toEqual({
      status: 'done',
      output: { ok: true },
    });

    const withGuests = executorWithNoConfirmer(policy);
    expect(await withGuests.executor.execute('calendar.create_event', { to: '10:00', guests: ['x@y.z'] })).toEqual({
      status: 'denied',
    });
    expect(withGuests.audit.entries.at(-1)?.detail).toMatchObject({ effects: ['write', 'send'] });
  });

  it('records denied when the confirmer throws', async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(sendTool);
    const audit = new MemoryAuditLog();
    const executor = new PolicyToolExecutor({
      registry,
      confirmer: () => ({
        confirm: async () => {
          throw new Error('card failed');
        },
      }),
      policy: DEFAULT_CONFIRM_POLICY,
      audit,
      log: silentLogger,
    });

    expect(await executor.execute('mail.send', { to: 'a', body: 'b' })).toEqual({ status: 'denied' });
    expect(audit.entries.at(-1)?.detail).toMatchObject({ status: 'denied' });
  });

  it('fails tools that exceed the timeout', async () => {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: 'slow.tool',
      description: 'Slow',
      input: z.object({}),
      effects: ['read'],
      run: async (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const audit = new MemoryAuditLog();
    const executor = new PolicyToolExecutor({
      registry,
      confirmer: () => undefined,
      policy: DEFAULT_CONFIRM_POLICY,
      audit,
      log: silentLogger,
      timeoutMs: 5,
    });

    const outcome = await executor.execute('slow.tool', {});
    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/slow\.tool timed out/) });
  });

  it('stops waiting for a tool that ignores its abort signal', async () => {
    const registry = new InMemoryToolRegistry();
    let seen: AbortSignal | undefined;
    registry.register({
      name: 'stuck.tool',
      description: 'Never returns',
      input: z.object({}),
      effects: ['read'],
      timeoutMs: 20,
      run: async (_input, ctx) => {
        seen = ctx.signal;
        return await new Promise(() => undefined);
      },
    });
    const audit = new MemoryAuditLog();
    const executor = new PolicyToolExecutor({
      registry,
      confirmer: () => undefined,
      policy: DEFAULT_CONFIRM_POLICY,
      audit,
      log: silentLogger,
    });

    const started = Date.now();
    const outcome = await executor.execute('stuck.tool', {});
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/stuck\.tool timed out after/) });
    expect(seen?.aborted).toBe(true);
    expect(audit.entries.at(-1)?.detail).toMatchObject({ status: 'failed' });
  });

  it('lets a slow tool ask for a longer limit than the default', async () => {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: 'long.tool',
      description: 'Long',
      input: z.object({}),
      effects: ['read'],
      timeoutMs: 1_000,
      run: async () => new Promise((resolve) => setTimeout(() => resolve('ok'), 30)),
    });
    const executor = new PolicyToolExecutor({
      registry,
      confirmer: () => undefined,
      policy: DEFAULT_CONFIRM_POLICY,
      audit: new MemoryAuditLog(),
      log: silentLogger,
      timeoutMs: 5,
    });

    expect(await executor.execute('long.tool', {})).toEqual({ status: 'done', output: 'ok' });
  });
});
