import type { FirstLookCliDeps } from './first-look-cli.js';
import { followFirstLook, nodeFirstLookDeps, watchFirstLook } from './first-look-cli.js';
import { readLocalToken } from './first-look-api.js';
import { progressLine, resultLines } from './first-look-render.js';
import { createTtyPrompter } from './prompter.js';

/** What each subcommand says to the assistant, exactly as the owner would type it in chat. */
const PHRASES: Readonly<Record<string, string>> = {
  restart: '처음 알아보기',
  start: '처음 알아보기',
  stop: '알아보기 멈춰',
  resume: '알아보기 계속',
};

const WAIT_MS = 30_000;
const POLL_MS = 1_000;

export interface OnboardingCommandDeps {
  home: string;
  fetch?: typeof fetch;
  say?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  /** For `status` and `review`: the live bar and the correction loop (tests pass a scripted prompter and a fake API). */
  firstLook?: FirstLookCliDeps;
}

/**
 * `ax-kit onboarding status`: on a terminal the same live bar as setup (Ctrl+C leaves it running), then the result;
 * on a pipe one plain snapshot. `review`: the bar until done, then the "이대로 만들기 / 말로 고치기" loop.
 */
async function firstLookCommand(action: 'status' | 'review', deps: OnboardingCommandDeps): Promise<number> {
  const cli = deps.firstLook ?? nodeFirstLookDeps(deps.home, createTtyPrompter());
  if (action === 'review') {
    const end = await followFirstLook({ ...cli, waitServerMs: 0 }, { start: false });
    return end === 'unreachable' ? 1 : 0;
  }
  if (!cli.out.tty) {
    const view = await cli.api.view();
    if (view === undefined) {
      cli.prompter.say('비서가 이 맥에서 돌고 있지 않아요. 먼저 `ax-kit service install`(또는 `ax-kit start`)로 켜 주세요.');
      return 1;
    }
    cli.prompter.say(progressLine(view, cli.now()));
    if (view.result !== undefined) for (const line of resultLines(view.result)) cli.prompter.say(line);
    if (view.result?.plan?.status === 'proposed') cli.prompter.say('고치거나 만들려면: ax-kit onboarding review');
    return 0;
  }
  const watched = await watchFirstLook({ ...cli, waitServerMs: 0 }, { start: false });
  if (watched.end === 'unreachable') return 1;
  const result = watched.view?.result;
  if (watched.end === 'done' && result !== undefined) {
    for (const line of resultLines(result)) cli.prompter.say(line);
    if (result.plan?.status === 'proposed') cli.prompter.say('고치거나 만들려면: ax-kit onboarding review');
  }
  return 0;
}

/**
 * `ax-kit onboarding restart|status|stop|resume`: the owner's own terminal sends the first-look command to the running
 * assistant on this Mac (through its local-only token, the same one the desktop app uses) and prints the reply.
 */
export async function onboardingCommand(action: string | undefined, deps: OnboardingCommandDeps): Promise<number> {
  const say = deps.say ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (action === undefined || action === 'status' || action === 'review') return await firstLookCommand(action ?? 'status', deps);
  const phrase = PHRASES[action];
  if (phrase === undefined) {
    say('쓰는 법: ax-kit onboarding restart | status | review | stop | resume');
    return 2;
  }
  const local = await readLocalToken(deps.home);
  if (local === undefined) {
    say('비서가 이 맥에서 돌고 있지 않아요. 먼저 `ax-kit service install`(또는 `ax-kit start`)로 켜 주세요.');
    return 1;
  }
  const http = deps.fetch ?? fetch;
  const headers = { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' };
  let seq: number;
  try {
    const sent = await http(`${local.baseUrl}/m/v1/app/messages`, { method: 'POST', headers, body: JSON.stringify({ text: phrase }) });
    const body = (await sent.json()) as { ok?: boolean; seq?: number };
    if (!sent.ok || body.ok !== true || typeof body.seq !== 'number') throw new Error(`status ${sent.status}`);
    seq = body.seq;
  } catch (error) {
    say(`비서에게 보내지 못했어요(${error instanceof Error ? error.message : 'error'}). 비서가 켜져 있는지 \`ax-kit doctor\`로 확인해 주세요.`);
    return 1;
  }
  say(`보냈어요: "${phrase}"`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (deps.waitMs ?? WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      const got = await http(`${local.baseUrl}/m/v1/app/events?after=${seq}&limit=20`, { headers });
      const body = (await got.json()) as { events?: { type?: string; role?: string; text?: string }[] };
      const reply = (body.events ?? []).find((event) => (event.type === 'message' && event.role === 'assistant') || event.type === 'notice');
      if (reply?.text !== undefined) {
        say(reply.text);
        return 0;
      }
    } catch {
      // the assistant may be busy; keep waiting
    }
  }
  say('답이 아직 없어요. 진행 상황은 대화창 알림으로 와요.');
  return 0;
}
