import { describe, expect, it } from 'vitest';
import { trimLog } from '../../../src/channels/app/log.js';
import type { AppEvent } from '../../../src/channels/app/protocol.js';

const msg = (seq: number) => ({ type: 'message', seq, at: '', role: 'assistant', text: `m${seq}` }) as unknown as AppEvent;
const card = (seq: number, cardId: string) => ({ type: 'card', seq, at: '', cardId }) as unknown as AppEvent;
const closed = (seq: number, cardId: string) => ({ type: 'card_closed', seq, at: '', cardId }) as unknown as AppEvent;

describe('trimLog', () => {
  it('keeps the newest events and older cards still open', () => {
    const events = [card(1, 'open'), card(2, 'done'), msg(3), closed(4, 'done'), msg(5), msg(6)];
    expect(trimLog(events, 2).map((event) => event.seq)).toEqual([1, 5, 6]);
  });
});
