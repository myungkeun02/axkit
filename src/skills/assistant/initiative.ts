import { z } from 'zod';
import type { Bot, BotTeam } from '../../core/contracts/bots.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import type { Tool } from '../../core/tools/types.js';

const KEY = 'initiative';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A day's self-started turns, across all teams: enough to matter, bounded so it cannot run away. */
const MAX_TEAMS_PER_DAY = 8;
const NOTHING = /^\s*(오늘은\s*)?할\s*(일|게)\s*없(음|어요)/;

interface State {
  on: boolean;
  at: string;
  /** Local date each team last looked for work. */
  last: Record<string, string>;
}

const DEFAULT: State = { on: true, at: '10:00', last: {} };

/** What a team lead is asked once a day: find one thing worth doing for its purpose and do it (or say there is none). */
export function initiativeTask(team: BotTeam, korean: boolean): string {
  return korean
    ? [
        `오늘 '${team.name}' 팀이 스스로 찾아서 할 일이에요. 누가 시키지 않았어요.`,
        team.purpose !== undefined ? `팀 목적: ${team.purpose}` : '',
        '팀 문서·회사 문서·인물 카드와, 쓸 수 있는 도구(서비스 상태와 로그, 메일, 문서, 일정, 업무보드, 웹 검색 등)로 지금 상황을 먼저 직접 확인하세요.',
        '그중 이 팀 목적에 맞고 오늘 끝낼 수 있는 일 하나를 골라 하세요. 확인·정리·요약·초안까지는 직접 하고, 바꾸기·보내기·지우기는 늘 승인 카드로 물어요.',
        '같은 일을 매일 반복하지 말고, 할 만한 일이 없으면 정확히 "오늘은 할 일 없음"이라고만 답하세요.',
        '했다면 무엇을 왜 했고 결과가 무엇인지, 주인이 정할 것이 있으면 무엇인지 세 줄 안으로 답하세요.',
      ].filter((line) => line !== '').join('\n')
    : [
        `Today's self-started work for the '${team.name}' team; nobody asked.`,
        team.purpose !== undefined ? `Team purpose: ${team.purpose}` : '',
        'Check the situation yourself first with the team and company docs and the tools you have (service status and logs, mail, docs, calendar, web search).',
        'Pick one thing that fits the purpose and can be finished today, and do it: checking, organising, summarising and drafts yourself; changing, sending or deleting always on an approval card.',
        'Do not repeat the same thing every day. If nothing is worth doing, answer exactly "할 일 없음".',
        'If you did something, say in up to three lines what and why, the result, and anything the owner must decide.',
      ].filter((line) => line !== '').join('\n');
}

/**
 * Bots that find their own work: once a day (default 10:00), each team's lead looks at its area and does one useful
 * thing, through the same hand-over as a delegation (lead → staff → review, task panel, approval cards). The owner
 * hears about it only when something was done.
 */
export class Initiative {
  private busy = false;

  constructor(private readonly ctx: PluginContext, private readonly korean: boolean) {}

  async state(): Promise<State> {
    return { ...DEFAULT, ...((await this.ctx.kv.get<State>(KEY)) ?? {}) };
  }

  async set(on: boolean, at?: string): Promise<State> {
    const state = { ...(await this.state()), on, ...(at !== undefined ? { at } : {}) };
    await this.ctx.kv.set(KEY, state);
    return state;
  }

  async tick(now: Date): Promise<number> {
    // one pass at a time: a team's turn can take minutes
    if (this.busy) return 0;
    this.busy = true;
    try {
      return await this.pass(now);
    } finally {
      this.busy = false;
    }
  }

  private async pass(now: Date): Promise<number> {
    const state = await this.state();
    const directory = this.ctx.tryUse(Contracts.bots);
    if (!state.on || directory === undefined) return 0;
    const wall = wallClock(now, this.ctx.assistant.timezone);
    const day = `${wall.y}-${String(wall.m).padStart(2, '0')}-${String(wall.d).padStart(2, '0')}`;
    if (`${String(wall.hh).padStart(2, '0')}:${String(wall.mm).padStart(2, '0')}` < state.at) return 0;
    if ((await this.ctx.tryUse(Contracts.llmControl)?.overBudget().catch(() => false)) === true) return 0;
    const bots = await directory.list();
    const lead = (team: BotTeam): Bot | undefined => bots.find((bot) => bot.id === team.lead && bot.status !== 'off');
    // the assistant's own improvement room works on ax-kit itself, not on the owner's work
    const teams = (await directory.teams()).filter((team) => state.last[team.id] !== day && lead(team) !== undefined && !team.id.startsWith('team-ax'));
    let ran = 0;
    for (const team of teams) {
      if (Object.values(state.last).filter((value) => value === day).length >= MAX_TEAMS_PER_DAY) break;
      state.last[team.id] = day;
      await this.ctx.kv.set(KEY, state);
      const bot = lead(team) as Bot;
      const result = await this.ctx.tools.execute('bots.delegate', { bot: bot.id, task: initiativeTask(team, this.korean) }, { grounding: [] }).catch(() => undefined);
      ran += 1;
      const summary = result?.status === 'done' ? String((result as { output?: { summary?: unknown } }).output?.summary ?? '') : '';
      if (summary === '' || NOTHING.test(summary)) continue;
      await this.ctx.tryUse(Contracts.notifier)?.notify({ kind: 'bots.initiative', text: `[${team.name}] 스스로 찾아서 했어요: ${summary.slice(0, 400)}`, dedupeKey: `initiative:${team.id}:${day}` }).catch(() => undefined);
    }
    return ran;
  }
}

const input = z.object({
  on: z.boolean().describe('true: every team finds and does its own work once a day; false: bots only work when asked.'),
  at: z.string().regex(TIME).optional().describe('Local time each day, "HH:MM" (default 10:00).'),
});

/** Tool "bots.initiative": turns the teams' daily self-started work on or off, or moves its time. */
export function initiativeTool(initiative: Initiative): Tool<z.infer<typeof input>, { message: string }> {
  return {
    name: 'bots.initiative',
    description: "Turn on or off the teams finding their own work every day (each team lead does one useful thing for its purpose and reports only when it did something), or change the time. On by default.",
    input,
    effects: ['write'],
    async run(value) {
      const state = await initiative.set(value.on, value.at);
      return { message: state.on ? `매일 ${state.at}에 팀마다 스스로 일을 찾아서 해요.` : '이제 봇들은 시킬 때만 일해요.' };
    },
  };
}
