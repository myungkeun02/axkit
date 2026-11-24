import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolCallContext, ToolExecutor, ToolOutcome } from '../../src/core/tools/types.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { RegistryToolbox } from '../../src/core/tools/toolbox.js';

interface ExecuteCall {
  name: string;
  rawInput: unknown;
  call: ToolCallContext | undefined;
}

function registryWithNoteTool(): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: 'notes.create',
    description: 'Create a note.',
    input: z.object({
      title: z.string().describe('Short title'),
      tags: z.array(z.string()).optional(),
    }),
    effects: ['write'],
    run: async () => ({ ok: true }),
  });
  return registry;
}

function recordingExecutor(outcome: ToolOutcome = { status: 'done', output: { ok: true } }): {
  executor: ToolExecutor;
  calls: ExecuteCall[];
} {
  const calls: ExecuteCall[] = [];
  return {
    calls,
    executor: {
      async execute(name, rawInput, call) {
        calls.push({ name, rawInput, call });
        return outcome;
      },
    },
  };
}

describe('RegistryToolbox', () => {
  it('lists name, description, effects and a JSON Schema for a zod object input', () => {
    const { executor } = recordingExecutor();
    const toolbox = new RegistryToolbox(registryWithNoteTool(), executor);

    const info = toolbox.list()[0];
    expect(info?.name).toBe('notes.create');
    expect(info?.description).toBe('Create a note.');
    expect(info?.effects).toEqual(['write']);

    const schema = info?.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('title');
    expect(schema.properties).toHaveProperty('tags');
    expect(schema.required).toContain('title');
    expect(schema.required).not.toContain('tags');
  });

  it('can be used as a tool input schema by the model', () => {
    const { executor } = recordingExecutor();
    const [info] = new RegistryToolbox(registryWithNoteTool(), executor).list();

    expect(info?.inputSchema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('delegates execute to the wrapped executor with the call context', async () => {
    const { executor, calls } = recordingExecutor();
    const toolbox = new RegistryToolbox(registryWithNoteTool(), executor);
    const call: ToolCallContext = { grounding: ['메모를 추가해'] };

    const outcome = await toolbox.execute('notes.create', { title: '메모' }, call);

    expect(outcome).toEqual({ status: 'done', output: { ok: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('notes.create');
    expect(calls[0]?.rawInput).toEqual({ title: '메모' });
    expect(calls[0]?.call).toBe(call);
  });
});
