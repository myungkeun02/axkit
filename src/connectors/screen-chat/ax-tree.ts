import { z } from 'zod';

/** One Accessibility node, flattened in pre-order (a node's descendants follow it with greater depth). */
export interface AxNode {
  window: number;
  depth: number;
  role: string;
  subrole: string;
  identifier: string;
  label: string;
  value: string;
}

/** One read-only look at an app's windows, as the helper reports them. */
export interface AxSnapshot {
  running: boolean;
  frontmost: boolean;
  windows: string[];
  truncated: boolean;
  nodes: AxNode[];
}

export type ScreenReadErrorCode = 'accessibility' | 'helper' | 'timeout' | 'failed';

export class ScreenReadError extends Error {
  constructor(
    readonly code: ScreenReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScreenReadError';
  }
}

const NodeTuple = z.tuple([
  z.number().int(),
  z.number().int(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

const RunningOutput = z.object({
  ok: z.literal(true),
  running: z.literal(true),
  frontmost: z.boolean(),
  windows: z.array(z.string()),
  truncated: z.boolean(),
  nodes: z.array(NodeTuple),
});

const StoppedOutput = z.object({ ok: z.literal(true), running: z.literal(false) });
const FailedOutput = z.object({ ok: z.literal(false), error: z.string() });

/** Parses one helper document; an accessibility refusal stays distinguishable from a broken helper. */
export function parseSnapshot(raw: unknown): AxSnapshot {
  const failed = FailedOutput.safeParse(raw);
  if (failed.success) {
    const accessibility = failed.data.error === 'accessibility';
    throw new ScreenReadError(
      accessibility ? 'accessibility' : 'helper',
      accessibility
        ? 'Accessibility permission is not granted.'
        : `ax-read failed: ${failed.data.error}`,
    );
  }

  const stopped = StoppedOutput.safeParse(raw);
  if (stopped.success) {
    return { running: false, frontmost: false, windows: [], truncated: false, nodes: [] };
  }

  const running = RunningOutput.safeParse(raw);
  if (!running.success) throw new ScreenReadError('helper', 'ax-read returned an unexpected document.');
  const data = running.data;
  return {
    running: true,
    frontmost: data.frontmost,
    windows: data.windows,
    truncated: data.truncated,
    nodes: data.nodes.map(([window, depth, role, subrole, identifier, label, value]) => ({
      window,
      depth,
      role,
      subrole,
      identifier,
      label,
      value,
    })),
  };
}

/** Nodes after `index` that belong to it: pre-order descendants with a greater depth. */
export function descendants(nodes: readonly AxNode[], index: number): AxNode[] {
  const node = nodes[index];
  if (node === undefined) return [];
  const result: AxNode[] = [];
  for (let cursor = index + 1; cursor < nodes.length; cursor += 1) {
    const next = nodes[cursor];
    if (next === undefined || next.depth <= node.depth) break;
    result.push(next);
  }
  return result;
}

/** The text a node shows to a person; the value wins over the label. */
export function nodeText(node: AxNode): string {
  return node.value !== '' ? node.value : node.label;
}
