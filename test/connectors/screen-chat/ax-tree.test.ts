import { describe, expect, it } from 'vitest';
import {
  descendants,
  nodeText,
  parseSnapshot,
  ScreenReadError,
} from '../../../src/connectors/screen-chat/ax-tree.js';
import type { AxNode } from '../../../src/connectors/screen-chat/ax-tree.js';

function node(overrides: Partial<AxNode>): AxNode {
  return {
    window: 0,
    depth: 0,
    role: '',
    subrole: '',
    identifier: '',
    label: '',
    value: '',
    ...overrides,
  };
}

describe('Accessibility tree helpers', () => {
  it('returns the pre-order descendants of a node', () => {
    const nodes: AxNode[] = [
      node({ depth: 0 }),
      node({ depth: 1 }),
      node({ depth: 2 }),
      node({ depth: 1 }),
    ];

    expect(descendants(nodes, 0).map((entry) => entry.depth)).toEqual([1, 2, 1]);
    expect(descendants(nodes, 1).map((entry) => entry.depth)).toEqual([2]);
    expect(descendants(nodes, 3)).toEqual([]);
    expect(descendants(nodes, 99)).toEqual([]);
  });

  it('uses value first and label second', () => {
    expect(nodeText(node({ label: 'label', value: '' }))).toBe('label');
    expect(nodeText(node({ label: 'label', value: 'value' }))).toBe('value');
  });

  it('turns a stopped helper document into an empty snapshot', () => {
    expect(parseSnapshot({ ok: true, running: false })).toEqual({
      running: false,
      frontmost: false,
      windows: [],
      truncated: false,
      nodes: [],
    });
  });

  it('keeps an accessibility refusal distinguishable', () => {
    const error = (() => {
      try {
        parseSnapshot({ ok: false, error: 'accessibility' });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ScreenReadError);
    expect(error).toMatchObject({ code: 'accessibility' });
  });
});
