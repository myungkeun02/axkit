import type { AxNode, AxSnapshot } from '../../../src/connectors/screen-chat/ax-tree.js';
import type { AxReader } from '../../../src/connectors/screen-chat/reader.js';
import type { Logger } from '../../../src/core/log/types.js';
import type { ProcessRunner, RunOptions, RunResult } from '../../../src/core/process/types.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');
export const HOME = '/Users/example';

export interface TreeNode {
  role?: string;
  subrole?: string;
  identifier?: string;
  label?: string;
  value?: string;
  children?: readonly TreeNode[];
}

export interface FakeWindow {
  title: string;
  roots: readonly TreeNode[];
}

export function axSnapshot(windows: readonly FakeWindow[], extra: Partial<AxSnapshot> = {}): AxSnapshot {
  const nodes: AxNode[] = [];
  windows.forEach((window, windowIndex) => {
    const visit = (tree: TreeNode, depth: number): void => {
      nodes.push({
        window: windowIndex,
        depth,
        role: tree.role ?? '',
        subrole: tree.subrole ?? '',
        identifier: tree.identifier ?? '',
        label: tree.label ?? '',
        value: tree.value ?? '',
      });
      for (const child of tree.children ?? []) visit(child, depth + 1);
    };
    for (const root of window.roots) visit(root, 0);
  });
  return {
    running: true,
    frontmost: false,
    windows: windows.map((window) => window.title),
    truncated: false,
    nodes,
    ...extra,
  };
}

export function textNode(label: string, extra: Omit<TreeNode, 'label'> = {}): TreeNode {
  return { role: 'AXStaticText', label, ...extra };
}

export function badgeNode(value: string): TreeNode {
  return { role: 'AXStaticText', identifier: 'Count Label', value };
}

export function rowNode(children: readonly TreeNode[]): TreeNode {
  return { role: 'AXRow', children };
}

export function tableNode(children: readonly TreeNode[], role = 'AXTable'): TreeNode {
  return { role, children };
}

export class FakeAxReader implements AxReader {
  readonly dumpCalls: { bundleIds: readonly string[]; maxNodes?: number }[] = [];
  trustedCalls = 0;
  trustedValue = false;
  failure?: Error;
  snapshot: AxSnapshot = axSnapshot([]);

  async trusted(): Promise<boolean> {
    this.trustedCalls += 1;
    if (this.failure !== undefined) throw this.failure;
    return this.trustedValue;
  }

  async dump(bundleIds: readonly string[], maxNodes?: number): Promise<AxSnapshot> {
    this.dumpCalls.push({ bundleIds, ...(maxNodes !== undefined ? { maxNodes } : {}) });
    if (this.failure !== undefined) throw this.failure;
    return this.snapshot;
  }
}

export interface RunCall {
  cmd: string;
  args: readonly string[];
  opts: RunOptions;
}

export type RunHandler = (
  cmd: string,
  args: readonly string[],
  opts: RunOptions,
) => RunResult | Promise<RunResult>;

export function okResult(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

export function fakeRunner(handler: RunHandler = () => okResult()): {
  run: ProcessRunner;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return handler(cmd, args, opts);
  };
  return { run, calls };
}

export class RecordingLogger implements Logger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  debug(): void {}
  info(message: string): void {
    this.infos.push(message);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
  child(): Logger {
    return this;
  }
}

export function stoppedSnapshot(): AxSnapshot {
  return { running: false, frontmost: false, windows: [], truncated: false, nodes: [] };
}
