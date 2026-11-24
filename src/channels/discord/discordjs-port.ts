import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import type { DiscordButtonPress, DiscordInbound, DiscordOutbound, DiscordPort } from './port.js';

const MAX_ROWS = 5;
const BUTTONS_PER_ROW = 5;

const STYLE: Record<NonNullable<DiscordOutbound['buttons']>[number]['style'] & string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

function buildComponents(payload: DiscordOutbound): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = payload.buttons ?? [];
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let start = 0; start < buttons.length && rows.length < MAX_ROWS; start += BUTTONS_PER_ROW) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const button of buttons.slice(start, start + BUTTONS_PER_ROW)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(button.customId)
          .setLabel(button.label)
          .setStyle(button.style === undefined ? ButtonStyle.Secondary : STYLE[button.style]),
      );
    }
    rows.push(row);
  }
  return rows;
}

export function createDiscordJsPort(): DiscordPort {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  let messageHandler: ((m: DiscordInbound) => void) | undefined;
  let buttonHandler: ((b: DiscordButtonPress) => void) | undefined;

  client.on('messageCreate', (message) => {
    if (messageHandler === undefined) return;
    const inbound: DiscordInbound = {
      id: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      isDm: message.channel.isDMBased(),
      content: message.content,
      createdAt: message.createdAt,
    };
    const replyToId = message.reference?.messageId;
    if (replyToId !== undefined) inbound.replyToId = replyToId;
    messageHandler(inbound);
  });

  client.on('interactionCreate', (interaction) => {
    if (!interaction.isButton()) return;
    if (buttonHandler === undefined) {
      void interaction.deferUpdate().catch(() => undefined);
      return;
    }
    buttonHandler({
      customId: interaction.customId,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
      ack: async () => {
        await interaction.deferUpdate();
      },
    });
  });

  return {
    async login(token: string): Promise<{ botUserId: string }> {
      await client.login(token);
      const user = client.user;
      if (user === null) throw new Error('Discord login did not return a bot user');
      return { botUserId: user.id };
    },

    async recent(channelId: string, limit: number): Promise<DiscordInbound[]> {
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !channel.isTextBased()) return [];
      const messages = await channel.messages.fetch({ limit: Math.min(50, Math.max(1, limit)) });
      return [...messages.values()].map((message) => ({
        id: message.id,
        channelId: message.channelId,
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        isDm: message.channel.isDMBased(),
        content: message.content,
        createdAt: message.createdAt,
      }));
    },

    onMessage(cb: (m: DiscordInbound) => void): void {
      messageHandler = cb;
    },

    onButton(cb: (b: DiscordButtonPress) => void): void {
      buttonHandler = cb;
    },

    async send(channelId: string, payload: DiscordOutbound): Promise<{ messageId: string }> {
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !channel.isSendable()) {
        throw new Error(`Discord channel ${channelId} cannot receive messages`);
      }
      const message = await channel.send({ content: payload.content, components: buildComponents(payload) });
      return { messageId: message.id };
    },

    async openDm(userId: string): Promise<string> {
      const user = await client.users.fetch(userId);
      const dm = await user.createDM();
      return dm.id;
    },

    async editComponentsOff(channelId: string, messageId: string, note: string): Promise<void> {
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !channel.isTextBased()) {
        throw new Error(`Discord channel ${channelId} is not text based`);
      }
      const message = await channel.messages.fetch(messageId);
      await message.edit({ content: note, components: [] });
    },

    async destroy(): Promise<void> {
      await client.destroy();
    },
  };
}
