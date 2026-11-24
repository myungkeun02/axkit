import type { WorkItem, WorkStatus } from '../../core/contracts/index.js';

/** Owner-facing words for long tasks: the acknowledgement, the restart notice and the "어떻게 됐어?" answer. */
export interface WorkTexts {
  readonly korean: boolean;
  started(id: string): string;
  queued(id: string, ahead: number): string;
  /** Queued behind a page handed to the owner: the browser stays theirs until they finish it. */
  queuedBehindOwner(id: string): string;
  /** Added to a handoff notice when other tasks wait behind it. */
  othersWaiting(count: number): string;
  queueFull(count: number): string;
  handoffExpired: string;
  handoffCancelled: string;
  interrupted(title: string, resumeHint: string | undefined): string;
  status(status: WorkStatus): string;
  minutes(elapsed: number): string;
  line(item: WorkItem, now: Date): string;
  overview(active: readonly WorkItem[], recent: readonly WorkItem[], now: Date): string;
  viewTitle: string;
}

function elapsedMinutes(item: WorkItem, now: Date): number {
  const started = Date.parse(item.startedAt);
  return Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now.getTime() - started) / 60_000));
}

const KO_STATUS: Record<WorkStatus, string> = {
  queued: '순서 기다리는 중',
  running: '하는 중',
  waiting: '확인 기다리는 중',
  done: '끝남',
  failed: '못 끝냄',
  interrupted: '중간에 멈춤',
};

const EN_STATUS: Record<WorkStatus, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for you',
  done: 'done',
  failed: 'did not finish',
  interrupted: 'interrupted',
};

const KO: WorkTexts = {
  korean: true,
  started: (id) => `시작했어요. 끝나면 알려드릴게요. (작업 ${id})`,
  queued: (id, ahead) =>
    `지금 하던 일이 ${ahead}개 있어서 그다음 순서로 해 둘게요. 끝나면 알려드릴게요. (작업 ${id})`,
  queuedBehindOwner: (id) =>
    `지금 브라우저에서 직접 하시는 걸 기다리고 있어서, 그게 끝나면 이어서 할게요. 끝나면 알려드릴게요. (작업 ${id})`,
  othersWaiting: (count) => `뒤에 기다리는 일 ${count}개는 직접 하신 뒤에 이어서 할게요.`,
  queueFull: (count) => `기다리는 일이 ${count}개나 밀려 있어서 더 받지 않았어요. 앞의 일이 끝난 뒤에 다시 말씀해 주세요.`,
  handoffExpired: '직접 하실 시간이 지나서 정리하고 브라우저를 다음 일에 넘겼어요.',
  handoffCancelled: '브라우저가 멈춰서 이 일은 접었어요.',
  interrupted: (title, hint) =>
    `서버가 다시 시작되면서 '${title}' 작업이 중간에 멈췄어요.${hint === undefined ? ' 다시 하려면 말씀해 주세요.' : ` ${hint}`}`,
  status: (status) => KO_STATUS[status],
  minutes: (elapsed) => (elapsed < 1 ? '방금 시작' : `${elapsed}분째`),
  line(item, now) {
    const phase = item.phase !== undefined && item.status === 'running' ? ` — ${item.phase}` : '';
    const time = item.status === 'running' || item.status === 'queued' ? ` (${KO.minutes(elapsedMinutes(item, now))})` : '';
    return `· ${item.title}: ${KO.status(item.status)}${phase}${time}`;
  },
  overview(active, recent, now) {
    const lines: string[] = [];
    lines.push(active.length === 0 ? '지금 하고 있는 일은 없어요.' : `지금 하고 있는 일 ${active.length}개`);
    lines.push(...active.map((item) => KO.line(item, now)));
    if (recent.length > 0) {
      lines.push('최근에 끝난 일');
      lines.push(...recent.map((item) => KO.line(item, now)));
    }
    return lines.join('\n');
  },
  viewTitle: '하고 있는 일',
};

const EN: WorkTexts = {
  korean: false,
  started: (id) => `Started. I'll let you know when it's done. (task ${id})`,
  queued: (id, ahead) => `${ahead} task(s) are ahead of it, so it's queued next. I'll let you know when it's done. (task ${id})`,
  queuedBehindOwner: (id) =>
    `The browser is waiting for you to finish a step yourself; this runs right after. I'll let you know when it's done. (task ${id})`,
  othersWaiting: (count) => `${count} more task(s) will run after you finish.`,
  queueFull: (count) => `${count} tasks are already waiting, so I didn't take this one. Ask again once those finish.`,
  handoffExpired: 'The step was left for too long, so I closed it and moved on.',
  handoffCancelled: 'The browser was stopped, so this one was dropped.',
  interrupted: (title, hint) =>
    `The server restarted and '${title}' stopped partway.${hint === undefined ? ' Ask me again to redo it.' : ` ${hint}`}`,
  status: (status) => EN_STATUS[status],
  minutes: (elapsed) => (elapsed < 1 ? 'just started' : `${elapsed} min`),
  line(item, now) {
    const phase = item.phase !== undefined && item.status === 'running' ? ` — ${item.phase}` : '';
    const time = item.status === 'running' || item.status === 'queued' ? ` (${EN.minutes(elapsedMinutes(item, now))})` : '';
    return `· ${item.title}: ${EN.status(item.status)}${phase}${time}`;
  },
  overview(active, recent, now) {
    const lines: string[] = [];
    lines.push(active.length === 0 ? 'Nothing is in progress.' : `${active.length} in progress`);
    lines.push(...active.map((item) => EN.line(item, now)));
    if (recent.length > 0) {
      lines.push('Recently finished');
      lines.push(...recent.map((item) => EN.line(item, now)));
    }
    return lines.join('\n');
  },
  viewTitle: 'Work in progress',
};

export function workTexts(language: string): WorkTexts {
  return language === 'en' ? EN : KO;
}

export { elapsedMinutes };
