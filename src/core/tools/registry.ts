import type { Tool, ToolRegistry } from './types.js';

const TOOL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  register<I, O>(tool: Tool<I, O>): void {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }
}
