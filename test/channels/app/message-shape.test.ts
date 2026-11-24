import { describe, expect, it } from 'vitest';
import { sendMessageSchema } from '../../../src/channels/app/protocol.js';

describe('sendMessageSchema', () => {
  it('takes an empty or null channel as the main chat (apps send the main room as "")', () => {
    const parsed = sendMessageSchema.safeParse({ choice: 'yes', channel: '', clientId: 'choice-12-yes' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.channel).toBeUndefined();
    expect(sendMessageSchema.safeParse({ text: 'hi', channel: null }).success).toBe(true);
  });

  it('still refuses a malformed room name and an empty message', () => {
    expect(sendMessageSchema.safeParse({ text: 'hi', channel: 'Bad Room' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ text: 'hi', channel: 'shop-s1' }).success).toBe(true);
  });
});
