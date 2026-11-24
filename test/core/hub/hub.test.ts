import { describe, expect, it } from 'vitest';
import { ChannelHub } from '../../../src/core/hub/hub.js';
import type { ConfirmAnswer, ConfirmOptions, Confirmer } from '../../../src/core/policy/types.js';
import type { OutgoingMessage } from '../../../src/core/conversation/types.js';
import { InMemoryEventBus } from '../../../src/core/events/bus.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';

class ManualConfirmer implements Confirmer {
  resolve: ((answer: ConfirmAnswer) => void) | undefined;
  aborted = false;
  confirm(_request: unknown, options: ConfirmOptions = {}): Promise<ConfirmAnswer> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      options.signal?.addEventListener('abort', () => {
        this.aborted = true;
        resolve('expired');
      });
    });
  }
}

function endpoint(id: string, sent: string[], confirmer?: Confirmer, fail = false) {
  return {
    id,
    replier: { reply: async (_to: unknown, m: OutgoingMessage) => void sent.push(`${id}:reply:${m.text}`) },
    owner: {
      send: async (m: OutgoingMessage) => {
        if (fail) throw new Error('down');
        sent.push(`${id}:${m.text}`);
      },
    },
    ...(confirmer !== undefined ? { confirmer } : {}),
  };
}

const request = { summary: 's', effects: ['send' as const], toolName: 't' };

describe('ChannelHub', () => {
  it('denies when no channel can ask', async () => {
    expect(await new ChannelHub().confirm(request)).toBe('denied');
  });

  it('replies on the channel the message came from and sends a notice to one channel', async () => {
    const sent: string[] = [];
    const hub = new ChannelHub();
    hub.register(endpoint('a', sent));
    hub.register(endpoint('b', sent));
    await hub.reply({ channelId: 'b', address: 'x' }, { text: 'hi' });
    await hub.send({ text: 'n' });
    expect(sent).toEqual(['b:reply:hi', 'a:n']);
    await hub.send({ text: 'u' }, { urgent: true });
    expect(sent.slice(-2)).toEqual(['a:u', 'b:u']);
    await expect(hub.reply({ channelId: 'c', address: 'x' }, { text: 'hi' })).rejects.toThrow();
    expect(() => hub.register(endpoint('a', sent))).toThrow();
  });

  it('keeps sending when one channel is down, fails only when all are', async () => {
    const sent: string[] = [];
    const hub = new ChannelHub();
    hub.register(endpoint('a', sent, undefined, true));
    hub.register(endpoint('b', sent));
    await hub.send({ text: 'n' });
    expect(sent).toEqual(['b:n']);
    const down = new ChannelHub();
    down.register(endpoint('a', sent, undefined, true));
    await expect(down.send({ text: 'n' })).rejects.toThrow('down');
  });

  it('takes the first answer and closes the other cards', async () => {
    const first = new ManualConfirmer();
    const second = new ManualConfirmer();
    const hub = new ChannelHub();
    hub.register(endpoint('a', [], first));
    hub.register(endpoint('b', [], second));
    const answer = hub.confirm(request);
    await Promise.resolve();
    second.resolve?.('approved');
    expect(await answer).toBe('approved');
    expect(first.aborted).toBe(true);
  });

  it('denies when every card failed to show', async () => {
    const broken: Confirmer = { confirm: async () => Promise.reject(new Error('x')) };
    const hub = new ChannelHub();
    hub.register(endpoint('a', [], broken));
    hub.register(endpoint('b', [], broken));
    expect(await hub.confirm(request)).toBe('denied');
  });

  it('sends a notice to the channel the owner wrote on last, falling back when it fails', async () => {
    const sent: string[] = [];
    const bus = new InMemoryEventBus(silentLogger);
    const hub = new ChannelHub();
    hub.attach(bus);
    hub.register(endpoint('app', sent));
    let discordDown = false;
    hub.register({
      ...endpoint('discord', sent),
      owner: {
        send: async (m: OutgoingMessage) => {
          if (discordDown) throw new Error('down');
          sent.push(`discord:${m.text}`);
        },
      },
    });
    const owner = (channelId: string, at: string, fromOwner = true) =>
      bus.emit('message.received', { id: at, conversation: { channelId, address: 'x' }, authorId: 'o', fromOwner, text: 'hi', receivedAt: new Date(at) });
    await owner('app', '2026-11-23T08:00:00Z');
    await owner('discord', '2026-11-23T09:00:00Z');
    await owner('app', '2026-11-23T10:00:00Z', false); // not the owner: ignored
    await hub.send({ text: '1' });
    expect(sent).toEqual(['discord:1']);
    expect(hub.lastOwnerActivity()?.toISOString()).toBe('2026-11-23T09:00:00.000Z');
    discordDown = true;
    await hub.send({ text: '2' });
    expect(sent).toEqual(['discord:1', 'app:2']);
  });

  it('prefers a channel the owner is looking at right now', async () => {
    const sent: string[] = [];
    const hub = new ChannelHub();
    let present = false;
    hub.register(endpoint('discord', sent));
    hub.register({ ...endpoint('app', sent), present: () => present });
    hub.noteOwnerActivity('discord', new Date('2026-11-23T09:00:00Z'));
    await hub.send({ text: '1' });
    present = true;
    await hub.send({ text: '2' });
    expect(sent).toEqual(['discord:1', 'app:2']);
    expect(hub.preferred()).toEqual(['app', 'discord']);
  });
});
