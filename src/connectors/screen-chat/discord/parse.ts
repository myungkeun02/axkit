import type { AxSnapshot } from '../ax-tree.js';

export type DiscordView =
  | { kind: 'dm'; name: string }
  | { kind: 'channel'; channel: string; server: string }
  | { kind: 'home' }
  | { kind: 'other'; title: string };

export interface DiscordDm {
  name: string;
  unread: boolean;
  mentions: number;
}

export interface DiscordMessage {
  author: string;
  bot: boolean;
  text: string;
  time: string;
}

export interface DiscordScreen {
  view: DiscordView;
  loggedIn: boolean;
  dms: DiscordDm[];
  messages: DiscordMessage[];
}

const DISCORD_SUFFIX = ' - Discord';
const DM_MARKERS = ['(다이렉트 메시지)', '(direct message)'] as const;
const UNREAD_KO = /^읽지 않음,\s*/;
const UNREAD_EN = /^unread,\s*/i;
const MENTIONS_KO = /^멘션\s*(\d+)\s*개,\s*/;
const MENTIONS_EN = /^(\d+)\s+mentions?,\s*/i;
const REPLY_KO = /님이.+답장/;
const REPLY_EN = /replying to/i;

function normalize(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function parseView(raw: string): DiscordView {
  const title = normalize(raw);
  const base = title.endsWith(DISCORD_SUFFIX) ? title.slice(0, -DISCORD_SUFFIX.length).trim() : title;
  if (base === '친구' || base === 'Friends') return { kind: 'home' };
  if (base.startsWith('@')) {
    const name = base.slice(1).trim();
    if (name !== '') return { kind: 'dm', name };
  }
  if (base.startsWith('#')) {
    const separator = base.indexOf(' | ');
    if (separator !== -1) {
      const channel = base.slice(1, separator).trim();
      const server = base.slice(separator + 3).trim();
      if (channel !== '' && server !== '') return { kind: 'channel', channel, server };
    }
  }
  return { kind: 'other', title: base };
}

function dmOf(raw: string): DiscordDm | undefined {
  const label = normalize(raw);
  const lower = label.toLowerCase();
  const marker = DM_MARKERS.find((candidate) => lower.includes(candidate));
  if (marker === undefined) return undefined;

  let rest = label.slice(0, lower.indexOf(marker)).trim();
  let unread = false;
  let mentions = 0;
  for (;;) {
    const koMentions = MENTIONS_KO.exec(rest);
    if (koMentions !== null) {
      mentions = Number(koMentions[1] ?? 0);
      unread = true;
      rest = rest.slice(koMentions[0].length);
      continue;
    }
    const enMentions = MENTIONS_EN.exec(rest);
    if (enMentions !== null) {
      mentions = Number(enMentions[1] ?? 0);
      unread = true;
      rest = rest.slice(enMentions[0].length);
      continue;
    }
    const koUnread = UNREAD_KO.exec(rest);
    if (koUnread !== null) {
      unread = true;
      rest = rest.slice(koUnread[0].length);
      continue;
    }
    const enUnread = UNREAD_EN.exec(rest);
    if (enUnread !== null) {
      unread = true;
      rest = rest.slice(enUnread[0].length);
      continue;
    }
    break;
  }

  const name = rest.trim();
  return name === '' ? undefined : { name, unread, mentions };
}

function authorOf(raw: string): { author: string; bot: boolean } {
  if (raw.endsWith(' 앱')) return { author: raw.slice(0, -2).trim(), bot: true };
  if (/ app$/i.test(raw)) return { author: raw.slice(0, -4).trim(), bot: true };
  return { author: raw, bot: false };
}

function messageOf(raw: string): DiscordMessage | undefined {
  const parts = normalize(raw).split(' , ');
  if (parts.length < 3) return undefined;
  const first = parts[0] ?? '';
  const skip = REPLY_KO.test(first) || REPLY_EN.test(first) ? 1 : 0;
  if (parts.length - skip < 3) return undefined;
  const authorPart = (parts[skip] ?? '').trim();
  const time = (parts[parts.length - 1] ?? '').trim();
  const text = parts.slice(skip + 1, parts.length - 1).join(' , ').trim();
  const { author, bot } = authorOf(authorPart);
  return author === '' ? undefined : { author, bot, text, time };
}

/** Reads the Discord window: the open view, the unread DM list and the visible messages. */
export function parseDiscordScreen(snapshot: AxSnapshot): DiscordScreen {
  const windows = snapshot.windows.map(normalize);
  const view = parseView(snapshot.windows[0] ?? '');
  const dms: DiscordDm[] = [];
  const messages: DiscordMessage[] = [];

  for (const node of snapshot.nodes) {
    if (node.role === 'AXLink') {
      const dm = dmOf(node.label);
      if (dm !== undefined) dms.push(dm);
    } else if (node.role === 'AXGroup') {
      const message = messageOf(node.label);
      if (message !== undefined) messages.push(message);
    }
  }

  const loggedIn =
    windows.some((title) => title.endsWith(DISCORD_SUFFIX)) && (dms.length > 0 || view.kind !== 'other');
  return { view, loggedIn, dms, messages };
}
