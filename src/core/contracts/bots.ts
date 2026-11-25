/**
 * Bots: specialists the assistant can hand work to, grouped by what the owner does (one group per company or life
 * area). Each bot has its own room: a conversation whose address is `bot:<id>`. The main chat stays the assistant's.
 */
export type BotStatus = 'idle' | 'working' | 'waiting' | 'off';
/** R16: every bot is part of a team: one lead, staff under it, and a reviewer on dev teams. */
export type BotRank = 'lead' | 'staff' | 'reviewer';
/** The app's tier letters (R12): S deep, A standard, B fast, C cheap (runs on B until a cheap model exists). */
export type TierLetter = 'S' | 'A' | 'B' | 'C';

export interface TeamTiers {
  lead: TierLetter;
  staff: TierLetter;
  reviewer?: TierLetter;
}

export interface BotTeam {
  /** "team-<word>": also the team room's channel id. */
  id: string;
  group: string;
  name: string;
  purpose?: string;
  kind: 'general' | 'dev';
  tiers: TeamTiers;
  /** The lead's bot id; delegating to the team means delegating to it. */
  lead: string;
  staffCount?: number;
  reviewerCount?: number;
  /** Who sized the team: the owner (then AI never changes it) or the composition harness. */
  decidedBy?: 'owner' | 'ai';
  /** The harness's one plain sentence, shown on top of the team settings. */
  reason?: string;
  createdAt: string;
}

/** Longest team name kept; longer ones are cut at a word and end with "…" (the same everywhere, so names still match). */
export const TEAM_NAME_MAX = 40;

export function teamName(raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ');
  if ([...text].length <= TEAM_NAME_MAX) return text;
  const cut = [...text].slice(0, TEAM_NAME_MAX - 1).join('');
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('-'), cut.lastIndexOf('_'));
  return `${(at >= TEAM_NAME_MAX / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** Leads always plan and decide on the top tier (S); staff on A so they use their tools well. */
export const DEFAULT_TIERS: TeamTiers = { lead: 'S', staff: 'A', reviewer: 'S' };
export const TEAM_ID = /^team-[a-z0-9-]{1,25}$/;
/** A company's lead meeting room (R17). */
export function meetingChannel(groupId: string): string {
  return `meet-${groupId}`.slice(0, 31);
}

export interface BotGroup {
  id: string;
  label: string;
  summary?: string;
}

export interface Bot {
  id: string;
  name: string;
  /** One plain sentence: what the bot does ("앱·서버 코드를 고쳐요"). */
  role: string;
  group?: string;
  kind: 'general' | 'dev';
  status: BotStatus;
  statusText?: string;
  /** Where the bot came from: the owner asked, company mode, the first document scan. */
  origin: 'owner' | 'company' | 'onboarding';
  rank?: BotRank;
  team?: string;
  /** Its role prompt, added to the persona in every turn; never loosens the approval rules (code enforces them). */
  instructions?: string;
  /** Who wrote it: the template, the model for the team's purpose, or the owner (then nothing replaces it). */
  instructionsBy?: 'default' | 'ai' | 'owner';
  createdAt: string;
}

export type BotInput = Omit<Bot, 'status' | 'createdAt'> & Partial<Pick<Bot, 'status' | 'statusText'>>;

/** Capability "bots.directory". */
export interface BotDirectory {
  list(): Promise<Bot[]>;
  get(id: string): Promise<Bot | undefined>;
  groups(): Promise<BotGroup[]>;
  upsert(bot: BotInput): Promise<Bot>;
  upsertGroup(group: BotGroup): Promise<void>;
  remove(id: string): Promise<boolean>;
  setStatus(id: string, status: BotStatus, text?: string): Promise<void>;
  teams(): Promise<BotTeam[]>;
  upsertTeam(team: BotTeam): Promise<void>;
  /** Removes a team and its members (their rooms' past messages stay in the log). False when there is no such team. */
  removeTeam?(id: string): Promise<boolean>;
  setInstructions(id: string, text: string, by: 'default' | 'ai' | 'owner'): Promise<void>;
}

/** What a delegation looks like to channels: one line when it starts, one when it ends. */
export interface DelegationEvent {
  bot: { id: string; name: string };
  task: string;
  state: 'started' | 'done' | 'failed';
  summary?: string;
}

export const BOT_ADDRESS_PREFIX = 'bot:';

export function botAddress(id: string): string {
  return `${BOT_ADDRESS_PREFIX}${id}`;
}

/** The bot id of a room address, or undefined for the main chat. */
export function botOfAddress(address: string): string | undefined {
  return address.startsWith(BOT_ADDRESS_PREFIX) ? address.slice(BOT_ADDRESS_PREFIX.length) : undefined;
}

export const BOT_ID = /^[a-z][a-z0-9-]{1,30}$/;
