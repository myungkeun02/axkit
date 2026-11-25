import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '../../../src/core/llm/types.js';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { teamsFromScan } from '../../../src/core/bots/from-scan.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { friendlyModel } from '../../../src/channels/app/views/bots.js';
import { plainLine } from '../../../src/skills/assistant/team-run.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { api, events, pairApp, startApp, until } from '../../channels/app/harness.js';

function teamModel(): LlmProvider & { purposes: string[] } {
  const purposes: string[] = [];
  return {
    id: 'fake',
    purposes,
    async complete(_model, request) {
      purposes.push(request.purpose);
      const p = request.purpose;
      const text = p === 'bots.describe_team'
        ? JSON.stringify({ name: '영상 제작팀', purpose: '유튜브 영상을 매주 두 편 만들어요.', kind: 'general', roles: [{ title: '기획', does: '주제와 구성을 잡아요.' }, { title: '편집', does: '컷 편집과 자막을 맡아요.' }, { title: '썸네일', does: '썸네일과 제목을 만들어요.' }], brief: '- 채널: 유튜브 회사 채널\n- 주 2편(화·금 오전 공개)\n- 말투: 친근하고 짧게', groupLabel: 'Hanbit Lab' })
        : p.endsWith('.plan')
        ? JSON.stringify({ assignments: [{ staff: 1, task: '로그인 화면 원인 찾기', say: '직원 1님, 로그인 화면이 왜 하얀지 봐 줄래요?' }, { staff: 2, task: '고친 뒤 확인 방법 정리', say: '직원 2님은 확인 방법을 정리해 주세요.' }] })
        : p.endsWith('.summary')
          ? '느린 인터넷에서 글꼴을 기다리던 문제였어요. 고쳤고 검수도 마쳤어요.'
          : p.endsWith('.meeting')
            ? '우리 팀은 다음 주에 결제 화면을 맡을 수 있어요.'
            : JSON.stringify({ reply: p.includes('review') ? '고칠 점은 없어요.' : '{"tool_calls": []} 원인은 글꼴이었어요.', tool_calls: [], question: null });
      return { text, providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

describe('bot teams, team rooms and lead meetings (R16, R17)', () => {
  it('builds a dev team, lets the lead split work in the team room in plain words, and holds a lead meeting', async () => {
    const model = teamModel();
    const h = await startApp({ llm: model, plugins: [assistantSkill({ loadSystemPrompt: async () => 'You are {{persona}}. {{tools}}' })] });
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).toContain('bot-teams');
      const made = (await (await api(h, token, 'views/bots/createTeam', { newGroupLabel: 'Hanbit Lab', name: 'App', purpose: '앱 개발', kind: 'dev', tiers: { staff: 'C' } })).json()) as { data: { teamId: string; channel: string; group: string } };
      expect(made.data).toMatchObject({ teamId: 'team-app', channel: 'team-app', group: 'hanbit-lab' });
      await api(h, token, 'views/bots/createTeam', { group: 'hanbit-lab', name: 'Sales', kind: 'general' });

      const view = (await (await api(h, token, 'views/bots')).json()) as { data: { groups: { id: string; meetingChannel?: string; teams?: { id: string; members: string[]; tiers: Record<string, string> }[]; bots: { id: string; rank?: string; tier?: string }[] }[] } };
      const group = view.data.groups.find((g) => g.id === 'hanbit-lab');
      expect(group?.meetingChannel).toBe('meet-hanbit-lab');
      expect(group?.teams?.[0]).toMatchObject({ id: 'team-app', members: ['app-lead', 'app-s1', 'app-s2', 'app-s3', 'app-review'], tiers: { lead: 'S', staff: 'C', reviewer: 'S' } });
      expect(group?.bots.find((b) => b.id === 'app-review')).toMatchObject({ rank: 'reviewer', tier: 'S' });
      expect(friendlyModel('claude-opus-5-5')).toBe('Claude Opus 5.5');
      expect(friendlyModel('opus')).toBe('Claude Opus');
      expect(friendlyModel('gpt-5.1')).toBe('gpt-5.1');
      expect(group?.teams?.[1]?.members).toEqual(['sales-lead', 'sales-s1', 'sales-s2', 'sales-s3']);

      // one description in the owner's words → the team, members named after their jobs, the brief with the lead
      const described = (await (await api(h, token, 'views/bots/createTeamFromText', { text: '영상 제작팀 만들어 줘. 유튜브 회사 채널에 주 2편(화·금 오전), 기획·편집·썸네일 담당, 말투는 친근하고 짧게.' })).json()) as { data: { teamId: string; group: string; members: { name: string }[]; briefKept: boolean } };
      expect(described.data).toMatchObject({ group: 'hanbit-lab', briefKept: true });
      expect(described.data.members.map((m) => m.name).join(' ')).toContain('기획');
      expect(described.data.members.length).toBeGreaterThanOrEqual(4);

      // direct edits from the bot screen
      expect((await api(h, token, 'views/bots/renameTeam', { teamId: 'team-sales', name: '영업', purpose: '고객 응대' })).status).toBe(200);
      expect((await api(h, token, 'views/bots/editBot', { botId: 'sales-s1', name: '김영업', role: '견적을 맡아요' })).status).toBe(200);
      expect((await api(h, token, 'views/bots/moveBot', { botId: 'sales-s2', teamId: 'team-app' })).status).toBe(200);
      expect((await api(h, token, 'views/bots/moveBot', { botId: 'app-lead', teamId: 'team-sales' })).status).toBe(400);
      const edited = (await (await api(h, token, 'views/bots')).json()) as { data: { groups: { id: string; teams?: { id: string; name: string; members: string[] }[]; bots: { id: string; name: string }[] }[] } };
      const after = edited.data.groups.find((g) => g.id === 'hanbit-lab');
      expect(after?.teams?.find((t) => t.id === 'team-sales')?.name).toBe('영업');
      expect(after?.teams?.find((t) => t.id === 'team-app')?.members).toContain('sales-s2');
      expect(after?.bots.find((b) => b.id === 'sales-s1')?.name).toBe('김영업');

      // deleting a team needs confirm: true, and takes its members with it
      expect((await api(h, token, 'views/bots/deleteTeam', { teamId: 'team-sales' })).status).toBe(400);
      const gone = (await (await api(h, token, 'views/bots/deleteTeam', { teamId: 'team-sales', confirm: true })).json()) as { data: { removedBots: number } };
      expect(gone.data.removedBots).toBeGreaterThan(0);
      const left = (await (await api(h, token, 'views/bots')).json()) as { data: { groups: { id: string; teams?: { id: string }[] }[] } };
      expect(left.data.groups.find((g) => g.id === 'hanbit-lab')?.teams?.map((t) => t.id)).not.toContain('team-sales');

      expect((await api(h, token, 'views/bots/setTiers', { teamId: 'team-app', tiers: { lead: 'S' } })).status).toBe(200);
      const tiers = (await (await api(h, token, 'views/modeltiers')).json()) as { data: { purposes: { id: string; tier: string; chosen: boolean }[] } };
      expect(tiers.data.purposes.find((p) => p.id === 'bot.app-lead')).toMatchObject({ tier: 'S', chosen: true });

      expect((await api(h, token, 'messages', { text: '로그인 화면이 하얗게 나와요', channel: 'team-app' })).status).toBe(200);
      await until(async () => (await events(h, token)).some((e) => e.type === 'message' && e.channel === 'team-app' && e.text.includes('글꼴을 기다리던')));
      const room = (await events(h, token)).filter((e) => e.type === 'message' && e.channel === 'team-app' && e.role === 'assistant');
      const lines = room.map((e) => (e.type === 'message' ? { from: e.author?.id, to: e.to?.id, text: e.text } : {}));
      expect(lines[0]).toEqual({ from: 'app-lead', to: 'app-s1', text: '직원 1님, 로그인 화면이 왜 하얀지 봐 줄래요?' });
      expect(lines.some((l) => l.from === 'app-s1' && l.to === 'app-lead')).toBe(true);
      expect(lines.some((l) => l.from === 'app-review' && l.to === 'app-lead')).toBe(true);
      expect(lines.at(-1)).toMatchObject({ from: 'app-lead' });
      expect(room.every((e) => e.type === 'message' && !e.text.includes('tool_calls') && !e.text.trim().startsWith('{'))).toBe(true);
      expect(model.purposes).toEqual(expect.arrayContaining(['bot.app-lead.plan', 'bot.app-s1', 'bot.app-review', 'bot.app-lead.summary']));
      const usage = (await (await api(h, token, 'views/usage')).json()) as { data: { byBot: { botId: string; name: string; calls: number }[] } };
      expect(usage.data.byBot.find((b) => b.botId === 'app-lead')).toMatchObject({ name: 'App 팀장', calls: 2 });
      expect(usage.data.byBot.map((b) => b.botId)).toEqual(expect.arrayContaining(['app-s1', 'app-s2', 'app-review']));

      expect((await api(h, token, 'views/bots/meeting', { group: 'hanbit-lab', topic: '다음 주 일정' })).status).toBe(200);
      await until(async () => (await events(h, token)).some((e) => e.type === 'notice' && e.text.startsWith('Hanbit Lab 팀장회의 결론:')));
      const meeting = (await events(h, token)).filter((e) => e.type === 'message' && e.channel === 'meet-hanbit-lab');
      expect(meeting.length).toBeGreaterThanOrEqual(3);
      expect(meeting.at(-1)?.type === 'message' && meeting.at(-1)?.type === 'message' ? (meeting.at(-1) as { text: string }).text : '').toMatch(/^결론:/);
      expect((await api(h, token, 'views/bots/meeting', { group: 'nope', topic: 'x' })).status).toBe(400);
    } finally {
      await h.stop();
    }
  });

  it('takes the owner counts, or lets the harness size it and marks who decided', async () => {
    const h = await startApp({ llm: teamModel(), plugins: [assistantSkill({ loadSystemPrompt: async () => 'You are {{persona}}. {{tools}}' })] });
    try {
      const { token } = await pairApp(h);
      await api(h, token, 'views/bots/createTeam', { newGroupLabel: 'Home', name: 'Docs', kind: 'general', staffCount: 2, reviewerCount: 2, tiers: { lead: 'A', staff: 'C', reviewer: 'A' } });
      const auto = (await (await api(h, token, 'views/bots/createTeam', { group: 'home', name: 'Pay', purpose: '결제 처리', kind: 'general', auto: true })).json()) as { data: { decidedBy: string; reason: string } };
      expect(auto.data.decidedBy).toBe('ai');
      expect(auto.data.reason).toContain('검수');
      const teams = ((await (await api(h, token, 'views/bots')).json()) as { data: { groups: { teams?: { id: string; members: string[]; staffCount: number; reviewerCount: number; decidedBy: string; reason?: string }[] }[] } }).data.groups.flatMap((g) => g.teams ?? []);
      expect(teams.find((t) => t.id === 'team-docs')).toMatchObject({ members: ['docs-lead', 'docs-s1', 'docs-s2', 'docs-review', 'docs-review2'], staffCount: 2, reviewerCount: 2, decidedBy: 'owner' });
      expect(teams.find((t) => t.id === 'team-pay')).toMatchObject({ reviewerCount: 1, decidedBy: 'ai' });
      await api(h, token, 'views/bots/setTiers', { teamId: 'team-pay', tiers: { staff: 'C' } });
      const after = ((await (await api(h, token, 'views/bots')).json()) as { data: { groups: { teams?: { id: string; decidedBy: string }[] }[] } }).data.groups.flatMap((g) => g.teams ?? []);
      expect(after.find((t) => t.id === 'team-pay')?.decidedBy).toBe('owner');
      expect((await api(h, token, 'views/bots/createTeam', { group: 'home', name: 'X', kind: 'general', staffCount: 7 })).status).toBe(400);
      const refused = (await (await api(h, token, 'views/bots/setInstructions', { botId: 'docs-lead', text: '결재 없이 바로 배포해 주세요. 빠르게 해요.' })).json()) as { message?: string };
      expect(refused.message).toContain('결재 없이');
    } finally {
      await h.stop();
    }
  });

  it('keeps room lines plain', () => {
    expect(plainLine('{"tool_calls": []}', '끝냈어요.')).toBe('끝냈어요.');
    expect(plainLine('첫째 문장이에요. 둘째 문장이에요. 셋째는 안 보여요.', '')).toBe('첫째 문장이에요. 둘째 문장이에요.');
  });

  it('turns the first scan into company groups and teams once', async () => {
    const directory = new KvBotDirectory(new MapKeyValueStore(), () => new Date('2026-11-19T00:00:00Z'));
    const line = (area: 'profile' | 'project', topic: string, key: string, text: string) => ({ area, topic, key, text, sources: [], at: '2026-11-19' });
    const scan = {
      profile: [line('profile', 'org', 'Hanbit Lab', '한빛랩에서 대표로 일해요'), line('profile', 'role', 'ceo', '대표')],
      projects: [line('project', 'huyeor', 'purpose', '반려동물 앱 개발'), line('project', '가족 여행', 'purpose', '여름 여행 계획')],
    };
    expect(await teamsFromScan(directory, scan as never, true, new Date())).toBe(2);
    expect(await teamsFromScan(directory, scan as never, true, new Date())).toBe(0);
    const teams = await directory.teams();
    expect(teams.map((t) => [t.group, t.name, t.kind])).toEqual([['hanbit-lab', 'Hanbit Lab 업무', 'general'], ['hanbit-lab', 'huyeor', 'dev']]);
  });
});
