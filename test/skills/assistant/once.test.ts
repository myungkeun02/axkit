import { describe, expect, it } from 'vitest';
import type { CompletedTool, OutgoingMessage } from '../../../src/core/conversation/types.js';
import { makeHarness, message, noteTool, plan } from './helpers.js';

describe('an action runs once', () => {
  it('the same change twice in a turn runs once; a different one still runs', async () => {
    const note = noteTool();
    const harness = await makeHarness({ script: [plan('', [{ name: 'notes.add', args: { text: '우유' } }, { name: 'notes.add', args: { text: '우유' } }, { name: 'notes.add', args: { text: '빵' } }]), plan('적었어요.')] });
    harness.ctx.registerTool(note.tool);
    const replies: OutgoingMessage[] = [];
    await harness.handler.handle(message('우유랑 빵 적어줘'), { reply: async (_to, out) => void replies.push(out) });
    expect(note.seen).toHaveLength(2);
    expect(JSON.stringify(harness.llm.requests[1]?.messages)).toContain('already done in this turn');
  });

  it('after a restart, what already ran (same tool, same arguments) is refused', async () => {
    const note = noteTool();
    const harness = await makeHarness({ script: [plan('', [{ name: 'notes.add', args: { text: '우유' } }]), plan('다 했어요.')] });
    harness.ctx.registerTool(note.tool);
    const resumed: CompletedTool[] = [{ name: 'notes.add', effects: ['write'], message: 'saved', args: JSON.stringify({ text: '우유' }) }];
    await harness.handler.handle(message('우유 적어줘'), { reply: async () => undefined }, { resumed });
    expect(note.seen).toHaveLength(0);
  });
});
