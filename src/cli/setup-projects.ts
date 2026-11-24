import { remoteDisplay } from '../core/remote/ids.js';
import type { PickedProject, ProjectCandidate } from '../skills/onboarding/projects.js';
import { byCompany } from '../skills/onboarding/projects.js';
import { chooseMany, chooseOrType } from './prompt-kit.js';
import type { Prompter } from './prompter.js';

const RECENT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SHOWN = 120;

function ago(at: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(at)) / DAY_MS);
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return '오늘';
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}달 전`;
  return `${Math.floor(days / 365)}년 전`;
}

function detail(candidate: ProjectCandidate, now: Date): string {
  const where = remoteDisplay(candidate.path);
  const parts = [...(where !== undefined ? [where] : []), ago(candidate.lastActive, now)];
  if (candidate.claude > 0) parts.push(`Claude ${candidate.claude}`);
  if (candidate.codex > 0) parts.push(`Codex ${candidate.codex}`);
  if (candidate.docs !== undefined) parts.push(`문서 ${candidate.docs}개`);
  return parts.filter((part) => part !== '').join(' · ');
}

/** "1-3, 7" → [1,2,3,7]; undefined when a part is not a number in range. */
export function parseSelection(value: string, max: number): number[] | undefined {
  const out = new Set<number>();
  for (const part of value.split(/[\s,]+/).filter((item) => item !== '')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    const from = Number.parseInt(range?.[1] ?? part, 10);
    const to = Number.parseInt(range?.[2] ?? part, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to) || String(from) !== (range?.[1] ?? part) || from < 1 || to > max || from > to) return undefined;
    for (let n = from; n <= to; n += 1) out.add(n);
  }
  return [...out].sort((left, right) => left - right);
}

/**
 * "acme=ACME, 3=베타랩": a number moves that project to a company, a name renames a company. Unknown parts are
 * reported and skipped.
 */
/**
 * Where each project belongs (a company, a client, or personal work), fixed by picking: no "a=b" syntax to learn.
 * Typed "a=b, 3=c" still works for people who like it.
 */
async function fixPlaces(prompter: Prompter, picked: PickedProject[], numbered: readonly ProjectCandidate[], companies: readonly string[]): Promise<void> {
  const answer = await chooseOrType(prompter, `프로젝트를 이렇게 묶었어요: ${companies.join(', ')}. 맞나요?`, [
    { value: '', label: '네, 맞아요' },
    { value: 'fix', label: '하나씩 고칠게요' },
  ], { type: { label: '직접 쓰기 (예: 1=에이컴퍼니)', placeholder: '1=에이컴퍼니, 3=개인' } });
  if (answer === '') return;
  if (answer !== 'fix') {
    const skipped = applyCompanyEdits(picked, numbered, answer);
    if (skipped.length > 0) prompter.say(`알아듣지 못해 건너뛴 것: ${skipped.join(', ')}`);
    return;
  }
  for (;;) {
    const which = await prompter.choose('어느 프로젝트를 고칠까요?', [...picked.map((item) => ({ value: item.path, label: `${item.name} — 지금: ${item.company}` })), { value: '', label: '다 고쳤어요' }], picked.length);
    const project = picked.find((item) => item.path === which);
    if (project === undefined) return;
    const place = (await prompter.text(`'${project.name}'은(는) 어디 일인가요? (회사·고객 이름, 또는 "개인")`, { default: project.company })).trim();
    if (place !== '') project.company = place;
  }
}

export function applyCompanyEdits(picked: PickedProject[], numbered: readonly ProjectCandidate[], edits: string): string[] {
  const skipped: string[] = [];
  for (const raw of edits.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    const match = /^(.+?)\s*=\s*(.+)$/.exec(raw);
    const left = match?.[1]?.trim() ?? '';
    const right = match?.[2]?.trim() ?? '';
    if (match === null || left === '' || right === '') {
      skipped.push(raw);
      continue;
    }
    if (/^\d+$/.test(left)) {
      const target = numbered[Number.parseInt(left, 10) - 1];
      const project = target === undefined ? undefined : picked.find((item) => item.path === target.path);
      if (project === undefined) skipped.push(raw);
      else project.company = right;
      continue;
    }
    const matches = picked.filter((item) => item.company === left);
    if (matches.length === 0) skipped.push(raw);
    for (const project of matches) project.company = right;
  }
  return skipped;
}

export interface ProjectStepDeps {
  prompter: Prompter;
  candidates: readonly ProjectCandidate[];
  /** What was picked before; those stay checked. */
  previous: readonly PickedProject[];
  now: Date;
}

/**
 * Shows the projects found, grouped by company, as one checklist (recent ones checked), then lets the owner fix a
 * company name if one is wrong. The assistant learns the picked ones and gets a team for each company.
 */
export async function askProjects(deps: ProjectStepDeps): Promise<PickedProject[]> {
  const { prompter, now } = deps;
  if (deps.candidates.length === 0) {
    prompter.say('폴더와 Claude·Codex 기록에서 프로젝트를 찾지 못했어요.');
    return [...deps.previous];
  }
  const before = new Map(deps.previous.map((item) => [item.path, item]));
  const cutoff = now.getTime() - RECENT_DAYS * DAY_MS;
  const withCompany = deps.candidates.slice(0, MAX_SHOWN).map((candidate) => ({ ...candidate, company: before.get(candidate.path)?.company ?? candidate.company }));
  const numbered = byCompany(withCompany).flatMap((company) => withCompany.filter((item) => item.company === company));
  prompter.say('찾은 일·프로젝트예요 (문서 폴더·코드 저장소·Claude Code·Codex 기록). 최근 것은 미리 골라 뒀어요.');
  const options = numbered.map((candidate) => ({
    value: candidate.path,
    label: `[${candidate.company}] ${before.get(candidate.path)?.name ?? candidate.name}  · ${detail(candidate, now)}`,
    hint: candidate.display,
    checked: deps.previous.length > 0 ? before.has(candidate.path) : Date.parse(candidate.lastActive) >= cutoff,
  }));
  const chosen = new Set(await chooseMany(prompter, '비서가 알아 둘 프로젝트를 골라 주세요', options));
  const picked: PickedProject[] = numbered
    .filter((item) => chosen.has(item.path))
    .map((item) => ({ path: item.path, name: before.get(item.path)?.name ?? item.name, company: item.company, ...(item.remote !== undefined ? { remote: item.remote } : {}) }));
  if (picked.length === 0) {
    prompter.say('프로젝트는 고르지 않았어요. 폴더만 훑어볼게요.');
    return [];
  }
  const companies = [...new Set(picked.map((item) => item.company))];
  // everything personal (a student, a freelancer, someone with no company): nothing to ask about where it belongs
  const allPersonal = companies.length === 1 && /^(개인|personal)$/i.test(companies[0] ?? '');
  if (!allPersonal) await fixPlaces(prompter, picked, numbered, companies);
  prompter.say(`가져올 프로젝트 ${picked.length}개${allPersonal ? '' : ` · 묶음 ${new Set(picked.map((item) => item.company)).size}개`}`);
  return picked;
}
