import type { OutgoingMessage, ConversationRef, Replier } from '../conversation/types.js';
import type { OwnerChannel, OwnerSendOptions } from '../contracts/notify.js';
import type { EventBus, Unsubscribe } from '../events/types.js';
import type { ConfirmAnswer, ConfirmOptions, ConfirmRequest, Confirmer } from '../policy/types.js';

/** One way of talking to the owner (Discord, the phone app). `id` is the channel plugin id used in ConversationRef. */
export interface ChannelEndpoint {
  id: string;
  replier: Replier;
  owner: OwnerChannel;
  confirmer?: Confirmer;
  /** True while the owner is looking at this channel right now (the app holds a live stream). */
  present?: () => boolean;
}

/** Capability "core.channels": channel plugins register here instead of providing replier/confirmer themselves. */
export interface ChannelRegistry {
  register(endpoint: ChannelEndpoint): void;
  ids(): readonly string[];
}

/**
 * Lets the owner use one channel or several. Replies go back where the message came from, a proactive message goes to
 * the one channel the owner is on (present now, else the one they wrote on last) and falls back to the others only
 * when that fails; urgent ones go everywhere. A confirmation card is shown everywhere: the first answer wins.
 */
export class ChannelHub implements ChannelRegistry, Replier, OwnerChannel, Confirmer {
  private readonly endpoints = new Map<string, ChannelEndpoint>();
  /** Epoch ms of the owner's last message per channel id. */
  private readonly lastOwnerAt = new Map<string, number>();

  register(endpoint: ChannelEndpoint): void {
    if (this.endpoints.has(endpoint.id)) throw new Error(`Channel already registered: ${endpoint.id}`);
    this.endpoints.set(endpoint.id, endpoint);
  }

  ids(): readonly string[] {
    return [...this.endpoints.keys()];
  }

  async reply(to: ConversationRef, message: OutgoingMessage): Promise<void> {
    const endpoint = this.endpoints.get(to.channelId);
    if (endpoint === undefined) throw new Error(`No channel for reply: ${to.channelId}`);
    await endpoint.replier.reply(to, message);
  }

  /** Follows the owner's own messages, so a notice goes where they were last. */
  attach(bus: EventBus): Unsubscribe {
    return bus.on('message.received', (message) => {
      if (message.fromOwner) this.noteOwnerActivity(message.conversation.channelId, message.receivedAt);
    });
  }

  noteOwnerActivity(channelId: string, at: Date): void {
    const time = at.getTime();
    if (Number.isFinite(time) && time >= (this.lastOwnerAt.get(channelId) ?? 0)) this.lastOwnerAt.set(channelId, time);
  }

  /** The owner's last message on any channel. */
  lastOwnerActivity(): Date | undefined {
    const times = [...this.lastOwnerAt.values()];
    return times.length === 0 ? undefined : new Date(Math.max(...times));
  }

  /** Where a proactive message goes first: present now, then the most recent owner message, then registration order. */
  preferred(): readonly string[] {
    const ranked = [...this.endpoints.values()].map((endpoint, index) => ({
      id: endpoint.id,
      index,
      present: safePresent(endpoint),
      last: this.lastOwnerAt.get(endpoint.id) ?? -1,
    }));
    ranked.sort((a, b) => Number(b.present) - Number(a.present) || b.last - a.last || a.index - b.index);
    return ranked.map((entry) => entry.id);
  }

  async send(message: OutgoingMessage, options: OwnerSendOptions = {}): Promise<void> {
    const endpoints = [...this.endpoints.values()];
    if (endpoints.length === 0) throw new Error('No owner channel is registered');
    if (options.urgent === true) {
      const results = await Promise.allSettled(endpoints.map((endpoint) => endpoint.owner.send(message, options)));
      if (results.some((result) => result.status === 'fulfilled')) return;
      const first = results[0];
      throw first?.status === 'rejected' ? first.reason : new Error('Sending failed');
    }
    let firstError: unknown;
    for (const id of this.preferred()) {
      const endpoint = this.endpoints.get(id);
      if (endpoint === undefined) continue;
      try {
        await endpoint.owner.send(message, options);
        return;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError instanceof Error ? firstError : new Error('Sending failed');
  }

  async confirm(request: ConfirmRequest, options: ConfirmOptions = {}): Promise<ConfirmAnswer> {
    const confirmers = [...this.endpoints.values()].flatMap((endpoint) =>
      endpoint.confirmer === undefined ? [] : [endpoint.confirmer],
    );
    // No place to ask means no: the policy's safe default.
    if (confirmers.length === 0) return 'denied';
    const [only] = confirmers;
    if (confirmers.length === 1 && only !== undefined) return await only.confirm(request, options);

    const controller = new AbortController();
    const outer = options.signal;
    const onOuterAbort = (): void => {
      controller.abort();
    };
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      return await firstAnswer(confirmers.map((confirmer) => confirmer.confirm(request, { signal: controller.signal })));
    } finally {
      outer?.removeEventListener('abort', onOuterAbort);
      controller.abort();
    }
  }
}

function safePresent(endpoint: ChannelEndpoint): boolean {
  try {
    return endpoint.present?.() === true;
  } catch {
    return false;
  }
}

/** The first card answered decides; a channel that failed to show its card does not count as an answer. */
function firstAnswer(pending: readonly Promise<ConfirmAnswer>[]): Promise<ConfirmAnswer> {
  return new Promise((resolve) => {
    let failed = 0;
    for (const answer of pending) {
      answer.then(resolve, () => {
        failed += 1;
        if (failed === pending.length) resolve('denied');
      });
    }
  });
}
