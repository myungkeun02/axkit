import { z } from 'zod';
import type { ToolCallContext, Toolbox, ToolExecutor, ToolInfo, ToolOutcome, ToolRegistry } from './types.js';

function schemaOf(input: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

/** Joins the registry (what exists) and the executor (how it runs) for the assistant loop. */
export class RegistryToolbox implements Toolbox {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
  ) {}

  list(): readonly ToolInfo[] {
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      effects: tool.effects,
      inputSchema: schemaOf(tool.input),
    }));
  }

  execute(name: string, rawInput: unknown, call?: ToolCallContext): Promise<ToolOutcome> {
    return this.executor.execute(name, rawInput, call);
  }
}
