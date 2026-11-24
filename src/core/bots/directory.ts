import type { Bot, BotDirectory, BotGroup, BotInput, BotStatus, BotTeam } from '../contracts/bots.js';
import { BOT_ID, TEAM_ID, teamName } from '../contracts/bots.js';
import type { KeyValueStore } from '../store/types.js';

/** A team is 4–5 bots, so this is about two dozen teams. */
const MAX_BOTS = 120;
const MAX_GROUPS = 12;
const MAX_TEAMS = 24;

interface Stored {
  bots: Bot[];
  groups: BotGroup[];
  teams?: BotTeam[];
}

/** The bot list in the core key-value store. Small by design: a few groups of a few bots. */
export class KvBotDirectory implements BotDirectory {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  async list(): Promise<Bot[]> {
    return (await this.load()).bots;
  }

  async get(id: string): Promise<Bot | undefined> {
    return (await this.load()).bots.find((bot) => bot.id === id);
  }

  async groups(): Promise<BotGroup[]> {
    return (await this.load()).groups;
  }

  async upsert(input: BotInput): Promise<Bot> {
    if (!BOT_ID.test(input.id)) throw new Error(`Invalid bot id: ${input.id}`);
    const stored = await this.load();
    const previous = stored.bots.find((bot) => bot.id === input.id);
    if (previous === undefined && stored.bots.length >= MAX_BOTS) throw new Error('Too many bots');
    const bot: Bot = {
      ...input,
      name: input.name.trim().slice(0, 40),
      role: input.role.trim().slice(0, 200),
      status: input.status ?? previous?.status ?? 'idle',
      ...(input.statusText !== undefined ? { statusText: input.statusText } : {}),
      // a re-upsert (company config, team resize) keeps the role prompt
      ...(input.instructions === undefined && previous?.instructions !== undefined ? { instructions: previous.instructions, instructionsBy: previous.instructionsBy ?? 'default' } : {}),
      createdAt: previous?.createdAt ?? this.now().toISOString(),
    };
    stored.bots = [...stored.bots.filter((item) => item.id !== bot.id), bot];
    await this.kv.set('state', stored);
    return bot;
  }

  async upsertGroup(group: BotGroup): Promise<void> {
    if (!BOT_ID.test(group.id)) throw new Error(`Invalid group id: ${group.id}`);
    const stored = await this.load();
    const exists = stored.groups.some((item) => item.id === group.id);
    if (!exists && stored.groups.length >= MAX_GROUPS) throw new Error('Too many groups');
    stored.groups = [...stored.groups.filter((item) => item.id !== group.id), { ...group, label: group.label.trim().slice(0, 40) }];
    await this.kv.set('state', stored);
  }

  async remove(id: string): Promise<boolean> {
    const stored = await this.load();
    const before = stored.bots.length;
    stored.bots = stored.bots.filter((bot) => bot.id !== id);
    await this.kv.set('state', stored);
    return stored.bots.length < before;
  }

  async setStatus(id: string, status: BotStatus, text?: string): Promise<void> {
    const stored = await this.load();
    stored.bots = stored.bots.map((bot) => {
      if (bot.id !== id) return bot;
      const next: Bot = { ...bot, status };
      if (text !== undefined) next.statusText = text.slice(0, 80);
      else delete next.statusText;
      return next;
    });
    await this.kv.set('state', stored);
  }

  async setInstructions(id: string, text: string, by: 'default' | 'ai' | 'owner'): Promise<void> {
    const stored = await this.load();
    stored.bots = stored.bots.map((bot) => (bot.id === id ? { ...bot, instructions: text.slice(0, 1500), instructionsBy: by } : bot));
    await this.kv.set('state', stored);
  }

  async teams(): Promise<BotTeam[]> {
    return (await this.load()).teams ?? [];
  }

  async upsertTeam(team: BotTeam): Promise<void> {
    if (!TEAM_ID.test(team.id)) throw new Error(`Invalid team id: ${team.id}`);
    const stored = await this.load();
    const teams = stored.teams ?? [];
    if (!teams.some((item) => item.id === team.id) && teams.length >= MAX_TEAMS) throw new Error('Too many teams');
    stored.teams = [...teams.filter((item) => item.id !== team.id), { ...team, name: teamName(team.name) }];
    await this.kv.set('state', stored);
  }

  private async load(): Promise<Stored> {
    const stored = await this.kv.get<Stored>('state');
    return { bots: stored?.bots ?? [], groups: stored?.groups ?? [], teams: stored?.teams ?? [] };
  }
}
