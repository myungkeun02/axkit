import type {
  DiscordButtonPress,
  DiscordInbound,
  DiscordOutbound,
  DiscordPort,
} from '../../../src/channels/discord/port.js';

export class FakeDiscordPort implements DiscordPort {
  readonly sent: { channelId: string; payload: DiscordOutbound }[] = [];
  readonly dms: string[] = [];
  readonly edits: { channelId: string; messageId: string; note: string }[] = [];
  readonly logins: string[] = [];
  destroyed = false;
  private messageHandler: ((m: DiscordInbound) => void) | undefined;
  private buttonHandler: ((b: DiscordButtonPress) => void) | undefined;

  async login(token: string): Promise<{ botUserId: string }> {
    this.logins.push(token);
    return { botUserId: 'bot-user' };
  }

  onMessage(cb: (m: DiscordInbound) => void): void {
    this.messageHandler = cb;
  }

  onButton(cb: (b: DiscordButtonPress) => void): void {
    this.buttonHandler = cb;
  }

  async send(channelId: string, payload: DiscordOutbound): Promise<{ messageId: string }> {
    this.sent.push({ channelId, payload });
    return { messageId: `msg-${this.sent.length}` };
  }

  async openDm(userId: string): Promise<string> {
    this.dms.push(userId);
    return `dm-${userId}`;
  }

  async editComponentsOff(channelId: string, messageId: string, note: string): Promise<void> {
    this.edits.push({ channelId, messageId, note });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  emitMessage(message: DiscordInbound): void {
    this.messageHandler?.(message);
  }

  press(button: DiscordButtonPress): void {
    this.buttonHandler?.(button);
  }
}
