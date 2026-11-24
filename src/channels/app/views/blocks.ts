import { Contracts } from '../../../core/contracts/index.js';
import type { AppView } from '../../../core/contracts/device-api.js';
import type { PluginContext } from '../../../core/plugin/types.js';

/**
 * R9: screens the server draws as blocks, so an ability the assistant gains shows up in the app with no app update.
 * Blocks: text, stat, list, note, ask (ask only sends a chat message; anything with an effect goes through the
 * assistant and its cards). Unknown kinds are skipped by the app.
 */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'stat'; title: string; value: string }
  | { kind: 'list'; title?: string; rows: { title: string; detail?: string; trailing?: string }[] }
  | { kind: 'note'; text: string }
  | { kind: 'ask'; title: string; message: string };

interface Ability {
  name: string;
  on: (features: ReadonlySet<string>) => boolean;
  how: string;
}

/** What the owner can have, whether it is on, and in plain words how to get it when it is not. */
function abilities(ctx: PluginContext): Ability[] {
  return [
    { name: '대화와 결재 카드', on: () => true, how: '' },
    { name: '푸시 알림', on: (f) => f.has('push'), how: '맥에 APNs 키를 넣어요: ax-kit setup' },
    { name: '봇 팀·팀장회의', on: (f) => f.has('bot-teams'), how: '봇 목록에서 팀 추가' },
    { name: '앞으로는 알아서 (결재 줄이기)', on: (f) => f.has('remember'), how: '' },
    { name: 'AI 연결·등급표', on: (f) => f.has('ai-connect'), how: '더보기 › AI 연결하기' },
    { name: '녹음 → 회의록', on: (f) => f.has('recordings'), how: '맥에서 ax-kit setup → 받아쓰기' },
    { name: '캘린더 보기', on: () => ctx.tryUse(Contracts.calendarRead) !== undefined, how: '맥에서 ax-kit connect google' },
    { name: '캘린더에 일정 추가', on: () => ctx.tryUse(Contracts.calendarWrite) !== undefined, how: '맥에서 ax-kit connect google' },
    { name: '메일 읽기', on: () => ctx.tryUse(Contracts.mailRead) !== undefined, how: '맥에서 ax-kit connect google' },
    { name: '회의록 Drive 저장', on: () => ctx.tryUse(Contracts.driveWrite) !== undefined, how: '맥에서 ax-kit setup → Google에서 Drive 켜기' },
    { name: '웹사이트 대신 하기 (예매·조회)', on: () => ctx.tryUse(Contracts.browser) !== undefined, how: '맥에서 ax-kit setup features › 브라우저 심부름' },
    { name: '길찾기·일정 지도', on: (f) => f.has('routes'), how: '맥에서 카카오·ODsay 키 넣기: ax-kit secret set ko.kakao.rest-key, ko.odsay.key' },
    { name: '파일 변경 추적·맥 전체 파일 찾기', on: (f) => f.has('file-changes'), how: '맥에서 ax-kit setup features → 내 파일 폴더 켜기' },
    { name: '루틴 (매일·매주 하는 일)', on: (f) => f.has('routines'), how: '' },
    { name: '웹에서 대신 하기 (Aside)', on: () => ctx.tryUse(Contracts.webAgent) !== undefined, how: '맥에 Aside 설치·로그인' },
    { name: '할 일', on: () => ctx.tryUse(Contracts.todoRead) !== undefined, how: '' },
    { name: '지출 정리', on: () => ctx.tryUse(Contracts.spendRead) !== undefined, how: '' },
    { name: '문서 지도', on: () => ctx.tryUse(Contracts.docs) !== undefined, how: '맥에서 ax-kit setup → 처음 문서 살펴보기' },
  ];
}

export function featuresBlocksView(ctx: PluginContext, features: () => readonly string[]): AppView {
  return {
    name: 'abilities',
    version: 1,
    ui: 'blocks',
    title: '할 수 있는 일',
    icon: 'sparkles',
    async read() {
      const set = new Set(features());
      const rows = abilities(ctx).map((item) => ({ ...item, isOn: item.on(set) }));
      const on = rows.filter((row) => row.isOn);
      const off = rows.filter((row) => !row.isOn);
      const blocks: Block[] = [
        { kind: 'stat', title: '켜진 기능', value: `${on.length}개` },
        { kind: 'list', title: '켜져 있어요', rows: on.map((row) => ({ title: row.name, trailing: '✓' })) },
      ];
      if (off.length > 0) {
        blocks.push({ kind: 'list', title: '꺼져 있어요', rows: off.map((row) => ({ title: row.name, ...(row.how !== '' ? { detail: row.how } : {}) })) });
        blocks.push({ kind: 'note', text: '앱은 맥이 켜 둔 기능만 보여 줘요. 맥에서 `ax-kit features`로도 볼 수 있어요.' });
        blocks.push({ kind: 'ask', title: '켜는 법 물어보기', message: '꺼진 기능을 켜려면 어떻게 해야 해?' });
      }
      return { title: '할 수 있는 일', blocks };
    },
  };
}

export function workBlocksView(ctx: PluginContext): AppView {
  return {
    name: 'work-week',
    version: 1,
    ui: 'blocks',
    title: '이번 주 한 일',
    icon: 'checklist',
    async read() {
      const now = ctx.clock.now();
      const entries = (await ctx.tryUse(Contracts.workLog)?.between(new Date(now.getTime() - 7 * 86_400_000), now, 200).catch(() => [])) ?? [];
      const byBot = new Map<string, number>();
      for (const entry of entries) byBot.set(entry.bot?.name ?? '비서', (byBot.get(entry.bot?.name ?? '비서') ?? 0) + 1);
      const blocks: Block[] = [{ kind: 'stat', title: '지난 7일', value: `${entries.length}건` }];
      if (entries.length === 0) blocks.push({ kind: 'text', text: '아직 기록된 일이 없어요. 비서나 봇에게 일을 맡기면 여기에 쌓여요.' });
      else {
        blocks.push({ kind: 'list', title: '누가 했나요', rows: [...byBot.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ title: name, trailing: `${count}건` })) });
        blocks.push({
          kind: 'list',
          title: '최근',
          rows: entries.slice(0, 15).map((entry) => ({ title: entry.title.slice(0, 80), ...(entry.detail !== undefined ? { detail: entry.detail.slice(0, 120) } : {}), trailing: entry.at.slice(5, 10).replace('-', '/') })),
        });
      }
      blocks.push({ kind: 'ask', title: '이번 주 정리해 줘', message: '이번 주에 한 일 정리해 줘' });
      return { title: '이번 주 한 일', blocks };
    },
  };
}
