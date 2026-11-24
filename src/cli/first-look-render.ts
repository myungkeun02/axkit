import type { FirstLookResult } from '../skills/assistant/first-look.js';
import type { FirstLookView } from './first-look-api.js';
import type { Paint } from './style.js';
import { PLAIN, truncate } from './style.js';

const RELATION: Readonly<Record<string, string>> = { employer: '다니는 곳', own: '내 사업', client: '고객사', partner: '협력사', personal: '개인' };
const STATUS: Readonly<Record<string, string>> = { idle: '시작 전', running: '읽는 중', paused: '멈춤', done: '끝', failed: '멈춤(오류)' };

/** "3분 12초" / "45초" / "1시간 5분". */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

export function elapsedMs(view: FirstLookView, nowMs: number): number {
  if (view.startedAt === null) return 0;
  const start = Date.parse(view.startedAt);
  const end = view.finishedAt !== undefined && view.status !== 'running' ? Date.parse(view.finishedAt) : nowMs;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

/** How long is left at the pace so far; undefined until there is a pace to go by. */
export function remainingMs(view: FirstLookView, nowMs: number): number | undefined {
  const spent = elapsedMs(view, nowMs);
  if (view.status !== 'running' || view.percent < 3 || spent < 5_000) return undefined;
  return (spent * (100 - view.percent)) / view.percent;
}

/** "폴더 파일 120/400 · 프로젝트 문서·대화 기록 12/40": every phase that has something to read. */
export function countsText(view: FirstLookView): string {
  const parts = view.phases.filter((phase) => phase.total > 0).map((phase) => `${phase.label} ${phase.done}/${phase.total}`);
  return parts.length > 0 ? parts.join(' · ') : '읽을 것을 세는 중…';
}

function activeLabel(view: FirstLookView): string {
  const active = view.phases.find((phase) => phase.state === 'active');
  if (view.status === 'running') return active !== undefined ? `${active.label} 읽는 중` : '준비 중';
  return STATUS[view.status] ?? view.status;
}

/** Three lines for a live terminal: what it is reading, the bar with percent and time, the counts. */
export function progressLines(view: FirstLookView, opts: { width: number; paint?: Paint; nowMs: number }): string[] {
  const paint = opts.paint ?? PLAIN;
  const percent = Math.max(0, Math.min(100, Math.round(view.percent)));
  const time = elapsedText(elapsedMs(view, opts.nowMs));
  const tail = ` ${String(percent).padStart(3)}% · ${time}`;
  const barWidth = Math.max(10, Math.min(40, opts.width - tail.length - 4));
  const filled = Math.round((percent / 100) * barWidth);
  const bar = `${paint.accent('█'.repeat(filled))}${paint.dim('░'.repeat(barWidth - filled))}`;
  const head = view.status === 'failed' && view.error !== undefined ? `${activeLabel(view)} · ${view.error}` : activeLabel(view);
  return [
    `${paint.bold('처음 알아보기')} · ${truncate(head, Math.max(10, opts.width - 18))}`,
    `  ${bar}${tail}`,
    `  ${paint.dim(truncate(countsText(view), Math.max(10, opts.width - 2)))}`,
  ];
}

/** One plain line for pipes and logs. */
export function progressLine(view: FirstLookView, nowMs: number): string {
  return `처음 알아보기 ${Math.round(view.percent)}% · ${activeLabel(view)} · ${countsText(view)} · ${elapsedText(elapsedMs(view, nowMs))}`;
}

/** The structure as a tree: ■ company (relation) / · project — team kind: roles / ↻ routine. */
export function treeLines(result: FirstLookResult): string[] {
  if (result.companies.length === 0) return ['  (나눌 회사·프로젝트를 찾지 못했어요)'];
  const lines: string[] = [];
  for (const company of result.companies) {
    lines.push(`■ ${company.name} (${RELATION[company.relation] ?? company.relation})`);
    for (const project of company.projects) {
      const kind = project.team.kind === 'dev' ? '개발팀' : '팀';
      const roles = project.team.roles.map((role) => role.title).join(', ');
      lines.push(`  · ${project.name} — ${kind}${roles !== '' ? `: ${roles}` : ''}`);
      for (const routine of project.routines) lines.push(`      ↻ ${routine.when} ${routine.title}`);
    }
  }
  return lines;
}

/** "당신은 이런 사람이군요: …" and the proposed structure. */
export function resultLines(result: FirstLookResult): string[] {
  return [
    '',
    `당신은 이런 사람이군요: ${result.about !== '' ? result.about : '(아직 한 줄로 정리하지 못했어요)'}`,
    '',
    '이런 조직 분류가 필요해 보여요:',
    ...treeLines(result),
  ];
}
