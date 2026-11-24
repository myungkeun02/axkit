import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Prompter } from './prompter.js';

/** Runs one Aside browser task in the owner's own signed-in browser and returns its final answer. */
export type AsideRunner = (prompt: string, timeoutMinutes: number) => Promise<{ ok: boolean; answer: string }>;

export const WORKSPACE_APIS = ['Gmail API', 'Google Calendar API', 'Google Drive API', 'Google Docs API', 'Google Sheets API', 'Google Tasks API', 'People API'] as const;

const ProjectSchema = z.object({ id: z.string().min(1), name: z.string().default(''), desktopClient: z.boolean().default(false), apis: z.array(z.string()).default([]) });
const SurveySchema = z.object({ projects: z.array(ProjectSchema).max(50), recommended: z.string().optional() });
export type CloudProject = z.infer<typeof ProjectSchema>;

function jsonIn(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const SURVEY_PROMPT =
  'Read-only: do not create, enable, change or delete anything, and never reveal or copy any client secret or key. ' +
  'Open https://console.cloud.google.com/ and look at every Google Cloud project this account can see. For each, note which of these APIs are enabled: ' +
  `${WORKSPACE_APIS.join(', ')}; and whether APIs & Services > Credentials has an OAuth client of type "Desktop app". ` +
  'Answer with ONLY one JSON object: {"projects":[{"id":"project-id","name":"Project name","desktopClient":true,"apis":["Gmail API"]}],"recommended":"project-id best to reuse for a desktop app needing all those APIs, or omit"}.';

function preparePrompt(projectId: string | undefined): string {
  const where =
    projectId === undefined
      ? 'Create a new Google Cloud project named "ax-kit" and use it.'
      : `Use the Google Cloud project with id "${projectId}" (https://console.cloud.google.com/home/dashboard?project=${projectId}).`;
  return (
    `${where} In that project: ` +
    `(1) enable these APIs if they are not enabled: ${WORKSPACE_APIS.join(', ')}. ` +
    '(2) Google Auth Platform / OAuth consent screen: if it is not configured, configure it as External with app name "ax-kit" and the signed-in account as support and developer contact; then publish it to "In production" (testing mode logs the app out every 7 days). Do not submit it for verification. ' +
    '(3) Clients: create a NEW OAuth client of type "Desktop app" named "ax-kit desktop" and download its JSON file (the "Download JSON" button) to the default Downloads folder. ' +
    'Never type, show, copy or repeat the client secret anywhere, including your answer. ' +
    'Answer with ONLY one JSON object: {"projectId":"…","apisEnabled":true|false,"consentReady":true|false,"downloaded":"file name of the downloaded JSON, or empty","problem":"short reason if something could not be done, or empty"}.'
  );
}

const PreparedSchema = z.object({ projectId: z.string().default(''), apisEnabled: z.boolean().default(false), consentReady: z.boolean().default(false), downloaded: z.string().default(''), problem: z.string().default('') });

/** The newest Google client JSON in Downloads written after `since` ("client_secret_….json"). */
export async function newestClientJson(since: number, dir = join(homedir(), 'Downloads')): Promise<string | undefined> {
  let newest: { path: string; at: number } | undefined;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^client_secret.*\.json$/i.test(name) && !/ax-kit.*\.json$/i.test(name)) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info === undefined || info.mtimeMs < since) continue;
    if (newest === undefined || info.mtimeMs > newest.at) newest = { path: join(dir, name), at: info.mtimeMs };
  }
  return newest?.path;
}

export interface AsideGoogleDeps {
  prompter: Prompter;
  aside: AsideRunner;
  readFile: (path: string) => Promise<string>;
  now?: () => number;
  findClientJson?: (since: number) => Promise<string | undefined>;
}

/**
 * The Google Cloud side done by Aside in the owner's own browser: look at their projects, let them pick one to reuse
 * (or a new one), then enable the APIs, set up the consent screen and download a desktop client. The client secret
 * never passes through Aside's answer or this terminal: setup reads the downloaded file. Undefined when it could not
 * finish, so the manual checklist follows.
 */
export async function prepareGoogleWithAside(deps: AsideGoogleDeps): Promise<string | undefined> {
  const { prompter } = deps;
  prompter.say('브라우저(Aside)가 Google Cloud 프로젝트를 살펴보는 중이에요… (1~3분, 아무것도 바꾸지 않아요)');
  const survey = await deps.aside(SURVEY_PROMPT, 10);
  const parsed = SurveySchema.safeParse(jsonIn(survey.answer));
  const projects = parsed.success ? parsed.data.projects : [];
  const recommended = parsed.success ? parsed.data.recommended : undefined;
  const ranked = [...projects].sort((left, right) => Number(right.id === recommended) - Number(left.id === recommended) || Number(right.desktopClient) - Number(left.desktopClient) || right.apis.length - left.apis.length);
  const label = (project: CloudProject): string =>
    `${project.name || project.id} (${project.id}) · API ${project.apis.length}/${WORKSPACE_APIS.length}${project.desktopClient ? ' · 데스크톱 클라이언트 있음' : ''}${project.id === recommended ? ' · 추천' : ''}`;
  const choice = await prompter.choose(
    projects.length > 0 ? '어느 Google Cloud 프로젝트를 쓸까요?' : '쓸 만한 프로젝트를 찾지 못했어요. 새로 만들까요?',
    [...ranked.slice(0, 8).map((project) => ({ value: project.id, label: label(project) })), { value: 'new', label: '새 프로젝트 만들기 (ax-kit)' }, { value: 'manual', label: '직접 할게요 (안내 보기)' }],
    0,
  );
  if (choice === 'manual') return undefined;
  prompter.say('브라우저가 API 켜기 · 동의 화면 · 데스크톱 클라이언트를 준비해요. 브라우저에 로그인이나 확인 창이 뜨면 직접 눌러 주세요. (3~8분)');
  const since = (deps.now ?? Date.now)();
  const prepared = await deps.aside(preparePrompt(choice === 'new' ? undefined : choice), 20);
  const result = PreparedSchema.safeParse(jsonIn(prepared.answer));
  const file = await (deps.findClientJson ?? newestClientJson)(since);
  if (file === undefined) {
    const problem = result.success && result.data.problem !== '' ? result.data.problem : prepared.ok ? '클라이언트 파일을 받지 못했어요' : '브라우저 작업이 끝나지 않았어요';
    prompter.say(`자동 준비를 마치지 못했어요: ${problem}. 아래 안내대로 직접 해 주세요.`);
    return undefined;
  }
  if (result.success && (!result.data.apisEnabled || !result.data.consentReady)) {
    prompter.say(`일부는 직접 확인해 주세요: ${result.data.apisEnabled ? '' : 'API 켜기 '}${result.data.consentReady ? '' : '동의 화면 게시'}`.trim());
  }
  prompter.say(`클라이언트 파일을 받았어요: ${file.replace(homedir(), '~')}`);
  return await deps.readFile(file);
}

/** The real runner: `aside exec --json --timeout <n>m <prompt>` when the Aside CLI is on this Mac, else undefined. */
export function nodeAsideRunner(resolve: (command: string) => string | undefined, run: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>): AsideRunner | undefined {
  const bin = resolve('aside');
  if (bin === undefined) return undefined;
  return async (prompt, minutes) => {
    const result = await run(bin, ['exec', '--json', '--timeout', `${minutes}m`, prompt], (minutes + 1) * 60_000).catch(() => ({ code: 1, stdout: '' }));
    const body = jsonIn(result.stdout) as { answer?: unknown; outcome?: unknown } | undefined;
    const answer = typeof body?.answer === 'string' ? body.answer : result.stdout;
    return { ok: result.code === 0 && body?.outcome !== 'failed', answer };
  };
}
