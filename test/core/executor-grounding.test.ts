import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  ConfirmAnswer,
  ConfirmPolicyConfig,
  ConfirmRequest,
  Confirmer,
} from '../../src/core/policy/types.js';
import type { Tool, ToolCallContext } from '../../src/core/tools/types.js';
import { MemoryAuditLog, silentLogger } from '../../src/core/log/console-logger.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { PolicyToolExecutor } from '../../src/core/tools/executor.js';

const NO_WRITE_CONFIRM: ConfirmPolicyConfig = { confirmWrites: false, expiresMinutes: 30 };

class RecordingConfirmer implements Confirmer {
  readonly requests: ConfirmRequest[] = [];
  constructor(public answer: ConfirmAnswer = 'approved') {}
  async confirm(request: ConfirmRequest): Promise<ConfirmAnswer> {
    this.requests.push(request);
    return this.answer;
  }
}

interface Setup {
  policy?: ConfirmPolicyConfig;
  confirmer?: Confirmer;
}

function setup(register: (registry: InMemoryToolRegistry) => void, opts: Setup = {}) {
  const registry = new InMemoryToolRegistry();
  register(registry);
  const audit = new MemoryAuditLog();
  const confirmer = opts.confirmer;
  const executor = new PolicyToolExecutor({
    registry,
    confirmer: () => confirmer,
    policy: opts.policy ?? NO_WRITE_CONFIRM,
    audit,
    log: silentLogger,
  });
  return { executor, audit };
}

describe('PolicyToolExecutor grounding checks', () => {
  it('rejects a call whose evidence is missing, without running the tool', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const { executor, audit } = setup((registry) => {
      const tool: Tool<{ summary: string }, { ok: boolean }> = {
        name: 'todo.create',
        description: 'Create a to-do',
        input: z.object({ summary: z.string() }),
        effects: ['write'],
        reject: () => 'the to-do is not in the message',
        run,
      };
      registry.register(tool);
    });

    const outcome = await executor.execute('todo.create', { summary: '내일 회의' }, { grounding: ['내일 회의'] });

    expect(outcome).toEqual({ status: 'rejected', reason: 'the to-do is not in the message' });
    expect(run).not.toHaveBeenCalled();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.detail).toMatchObject({ status: 'rejected', effects: ['write'] });
  });

  it('asks the owner when uncertainty is reported, even without write confirmation', async () => {
    const confirmer = new RecordingConfirmer('approved');
    const run = vi.fn(async () => ({ ok: true }));
    const { executor } = setup(
      (registry) => {
        const tool: Tool<{ summary: string }, { ok: boolean }> = {
          name: 'todo.create',
          description: 'Create a to-do',
          input: z.object({ summary: z.string() }),
          effects: ['write'],
          uncertainty: () => 'the time is a guess',
          run,
        };
        registry.register(tool);
      },
      { confirmer },
    );

    const outcome = await executor.execute('todo.create', { summary: '내일 회의' });

    expect(outcome).toEqual({ status: 'done', output: { ok: true } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]).toMatchObject({
      toolName: 'todo.create',
      effects: ['write'],
      note: 'the time is a guess',
    });
  });

  it('does not run the tool when the owner denies an uncertain call', async () => {
    const confirmer = new RecordingConfirmer('denied');
    const run = vi.fn(async () => ({ ok: true }));
    const { executor, audit } = setup(
      (registry) => {
        const tool: Tool<{ summary: string }, { ok: boolean }> = {
          name: 'todo.create',
          description: 'Create a to-do',
          input: z.object({ summary: z.string() }),
          effects: ['write'],
          uncertainty: () => 'the time is a guess',
          run,
        };
        registry.register(tool);
      },
      { confirmer },
    );

    const outcome = await executor.execute('todo.create', { summary: '내일 회의' });

    expect(outcome).toEqual({ status: 'denied' });
    expect(run).not.toHaveBeenCalled();
    expect(audit.entries.at(-1)?.detail).toMatchObject({ status: 'denied' });
  });

  it('treats a throwing uncertainty check as uncertain', async () => {
    const confirmer = new RecordingConfirmer('approved');
    const run = vi.fn(async () => ({ ok: true }));
    const { executor } = setup(
      (registry) => {
        const tool: Tool<{ summary: string }, { ok: boolean }> = {
          name: 'todo.create',
          description: 'Create a to-do',
          input: z.object({ summary: z.string() }),
          effects: ['write'],
          uncertainty: () => {
            throw new Error('checker bug');
          },
          run,
        };
        registry.register(tool);
      },
      { confirmer },
    );

    const outcome = await executor.execute('todo.create', { summary: '내일 회의' });

    expect(outcome).toEqual({ status: 'done', output: { ok: true } });
    expect(confirmer.requests[0]?.note).toBe('could not check certainty');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes the caller grounding to the tool run context', async () => {
    const seen: ToolCallContext[] = [];
    const { executor } = setup((registry) => {
      const tool: Tool<{ query: string }, { ok: boolean }> = {
        name: 'notes.read',
        description: 'Read notes',
        input: z.object({ query: z.string() }),
        effects: ['read'],
        run: async (_input, ctx) => {
          seen.push(ctx.call);
          return { ok: true };
        },
      };
      registry.register(tool);
    });

    const grounding = ['오늘 오후 3시에 회의가 있어요'];
    await executor.execute('notes.read', { query: '회의' }, { grounding });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.grounding).toEqual(grounding);
  });

  it('passes empty grounding when the caller gives none', async () => {
    const seen: ToolCallContext[] = [];
    const { executor } = setup((registry) => {
      const tool: Tool<{ query: string }, { ok: boolean }> = {
        name: 'notes.read',
        description: 'Read notes',
        input: z.object({ query: z.string() }),
        effects: ['read'],
        run: async (_input, ctx) => {
          seen.push(ctx.call);
          return { ok: true };
        },
      };
      registry.register(tool);
    });

    await executor.execute('notes.read', { query: '회의' });

    expect(seen[0]?.grounding).toEqual([]);
  });

  it('denies a send tool when no confirmer is available and does not run it', async () => {
    const run = vi.fn(async () => ({ sent: true }));
    const { executor, audit } = setup((registry) => {
      const tool: Tool<{ to: string }, { sent: boolean }> = {
        name: 'mail.send',
        description: 'Send mail',
        input: z.object({ to: z.string() }),
        effects: ['send'],
        run,
      };
      registry.register(tool);
    });

    const outcome = await executor.execute('mail.send', { to: 'alex@example.com' });

    expect(outcome).toEqual({ status: 'denied' });
    expect(run).not.toHaveBeenCalled();
    expect(audit.entries.at(-1)?.detail).toMatchObject({ status: 'denied', effects: ['send'] });
  });
});
