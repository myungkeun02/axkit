import type { AppView } from '../../core/contracts/device-api.js';
import { Contracts } from '../../core/contracts/index.js';
import type { MailTriaged } from '../../core/contracts/mail-intents.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { senderName } from './triage-locale.js';

const KEY = 'mail.recent-triaged';
const KEEP = 80;
const DAYS = 3;
const SHOW = 20;

interface Kept extends MailTriaged {
  at: string;
}

const KIND_LABEL: Record<string, string> = {
  question: '질문',
  document_request: '자료 요청',
  scheduling: '일정 잡기',
  introduction: '소개·연결',
  invitation: '초대',
  notice: '알림',
};

function ago(at: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${String(minutes)}분 전`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)}시간 전` : `${String(Math.round(hours / 24))}일 전`;
}

/** Keeps what the triage said about each new mail (who, what, how important), for the mail screen. */
export function rememberTriaged(ctx: PluginContext): void {
  ctx.bus.on('mail.triaged', async (event) => {
    const list = (await ctx.kv.get<Kept[]>(KEY)) ?? [];
    const next = [{ ...event, at: ctx.clock.now().toISOString() }, ...list.filter((item) => item.id !== event.id)].slice(0, KEEP);
    await ctx.kv.set(KEY, next);
  });
}

/**
 * App view "mail" (blocks): the last few days of mail as the triage read it — important first, then worth knowing —
 * each with one line on who wants what, and the mail still waiting for the owner's answer. Tapping a mail asks the
 * assistant what to do with it (reply, attachments, calendar), the same card as when it arrived.
 */
export function mailView(ctx: PluginContext): AppView {
  return {
    name: 'mail',
    version: 1,
    ui: 'blocks',
    title: '메일',
    icon: 'envelope',
    async read() {
      const now = ctx.clock.now();
      const since = now.getTime() - DAYS * 86_400_000;
      const kept = ((await ctx.kv.get<Kept[]>(KEY)) ?? []).filter((item) => Date.parse(item.at) >= since);
      const row = (item: Kept) => ({
        title: `${senderName(item.from)} — ${item.subject === '' ? '(제목 없음)' : item.subject}`.slice(0, 90),
        detail: [KIND_LABEL[item.kind], item.summary].filter((part) => part !== undefined && part !== '').join(' · ').slice(0, 160),
        trailing: ago(item.at, now),
        message: `"${item.subject || senderName(item.from)}" 메일 어떻게 할지 같이 정해 줘 (답장·첨부 요약·일정 확인 중에서)`,
      });
      const high = kept.filter((item) => item.importance === 'high').slice(0, SHOW);
      const normal = kept.filter((item) => item.importance === 'normal').slice(0, SHOW);
      const lowCount = kept.filter((item) => item.importance === 'low').length;
      const blocks: Record<string, unknown>[] = [];
      if (ctx.tryUse(Contracts.mailRead) === undefined) {
        return { title: '메일', blocks: [{ kind: 'text', text: '메일이 연결돼 있지 않아요.' }, { kind: 'note', text: '맥에서 `ax-kit connect google`로 Gmail을 연결해 주세요.' }] };
      }
      blocks.push({ kind: 'stat', title: `최근 ${String(DAYS)}일 비서가 읽은 메일`, value: `${String(kept.length)}통` });
      if (high.length > 0) blocks.push({ kind: 'list', title: `먼저 보실 메일 · ${String(high.length)}통`, rows: high.map(row) });
      if (normal.length > 0) blocks.push({ kind: 'list', title: `알아 두면 좋은 메일 · ${String(normal.length)}통`, rows: normal.map(row) });
      const awaiting = await ctx.tryUse(Contracts.mailAwaiting)?.awaitingReply({ olderThanHours: 24, newerThanDays: 7, limit: 8 }).catch(() => []);
      if (awaiting !== undefined && awaiting.length > 0) {
        blocks.push({
          kind: 'list',
          title: `답을 기다리는 메일 · ${String(awaiting.length)}통`,
          rows: awaiting.map((mail) => ({ title: `${senderName(mail.from)} — ${mail.subject || '(제목 없음)'}`.slice(0, 90), detail: mail.snippet.slice(0, 120), message: `"${mail.subject || senderName(mail.from)}" 메일에 답장 초안 써 줘` })),
        });
      }
      if (kept.length === 0) blocks.push({ kind: 'text', text: `최근 ${String(DAYS)}일 동안 새로 읽은 메일이 없어요.` });
      if (lowCount > 0) blocks.push({ kind: 'note', text: `광고·알림 메일 ${String(lowCount)}통은 따로 보여 드리지 않았어요.` });
      blocks.push({ kind: 'ask', title: '오늘 메일 요약해 줘', message: '오늘 온 메일 중요한 것만 요약해 줘' });
      blocks.push({ kind: 'ask', title: '메일 찾기', message: '메일에서 찾아 줘' });
      return { title: '메일', blocks };
    },
  };
}
