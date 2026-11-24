import { nodeCliRunner } from '../core/llm/providers/node-runner.js';
import { resolveCommand } from '../core/process/resolve-command.js';
import type { Prompter } from './prompter.js';
import { runAttached } from './update.js';

/** Installing and signing in to a subscription CLI right inside setup, so choosing it is enough. */
export interface CliConnectDeps {
  /** Full path of the command, or undefined when it is not installed. */
  find: (command: string) => string | undefined;
  /** true signed in, false not, undefined could not tell. */
  signedIn: (command: string, bin: string) => Promise<boolean | undefined>;
  /** Runs a command on this terminal (the owner sees and answers it). */
  attached: (command: string, args: readonly string[]) => Promise<number>;
}

const PACKAGE: Readonly<Record<string, string>> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const LOGIN: Readonly<Record<string, readonly string[]>> = { claude: ['auth', 'login'], codex: ['login'] };
const NAME: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' };

export type CliConnectResult = 'ready' | 'later' | 'other';

async function install(prompter: Prompter, deps: CliConnectDeps, command: string): Promise<'ok' | CliConnectResult> {
  const name = NAME[command] ?? command;
  const pkg = PACKAGE[command];
  const choice = await prompter.choose(
    `${name}가 이 맥에 없어요. 어떻게 할까요?`,
    [
      ...(pkg !== undefined && deps.find('npm') !== undefined ? [{ value: 'install', label: '지금 설치 (추천)', hint: `npm install -g ${pkg}` }] : []),
      { value: 'other', label: '다른 AI 고르기' },
      { value: 'later', label: '나중에 설치할게요', hint: '설치하고 로그인하면 비서가 바로 써요.' },
    ],
    0,
  );
  if (choice === 'other') return 'other';
  if (choice !== 'install' || pkg === undefined) return 'later';
  prompter.say(`${name} 설치 중…`);
  const code = await deps.attached('npm', ['install', '-g', pkg]);
  if (code !== 0 || deps.find(command) === undefined) {
    prompter.say(`설치하지 못했어요. 터미널에서 \`npm install -g ${pkg}\` 를 실행한 뒤 다시 해 주세요.`);
    return 'later';
  }
  return 'ok';
}

/**
 * After the owner picks a subscription CLI: installs it if missing, then signs in on this terminal if needed, and says
 * plainly when it is ready. "other" goes back to the AI list.
 */
export async function connectCli(prompter: Prompter, deps: CliConnectDeps, command: string): Promise<CliConnectResult> {
  const name = NAME[command] ?? command;
  if (deps.find(command) === undefined) {
    const installed = await install(prompter, deps, command);
    if (installed !== 'ok') return installed;
  }
  const bin = deps.find(command) ?? command;
  if ((await deps.signedIn(command, bin)) === true) {
    prompter.say(`✓ ${name}에 로그인돼 있어요. 비서가 이 구독으로 생각해요.`);
    return 'ready';
  }
  const choice = await prompter.choose(
    `${name} 로그인이 필요해요.`,
    [
      { value: 'login', label: '지금 로그인 (추천)', hint: '브라우저가 열리면 로그인하고 돌아오세요.' },
      { value: 'later', label: '나중에', hint: `터미널에서 \`${command} ${(LOGIN[command] ?? ['login']).join(' ')}\`` },
    ],
    0,
  );
  if (choice !== 'login') return 'later';
  await deps.attached(bin, LOGIN[command] ?? ['login']);
  if ((await deps.signedIn(command, bin)) === false) {
    prompter.say(`아직 로그인되지 않았어요. 나중에 \`${command} ${(LOGIN[command] ?? ['login']).join(' ')}\` 로 해 주세요.`);
    return 'later';
  }
  prompter.say(`✓ ${name} 연결됐어요.`);
  return 'ready';
}

/** The real Mac: PATH plus the usual install folders, `claude auth status` / `codex login status`. */
export function nodeCliConnect(): CliConnectDeps {
  return {
    find: (command) => resolveCommand(command),
    signedIn: async (command, bin) => {
      const args = command === 'claude' ? ['auth', 'status', '--json'] : command === 'codex' ? ['login', 'status'] : undefined;
      if (args === undefined) return undefined;
      try {
        const result = await nodeCliRunner(bin, args, '', { timeoutMs: 15_000 });
        if (command === 'claude') {
          const start = result.stdout.indexOf('{');
          const body = start >= 0 ? (JSON.parse(result.stdout.slice(start)) as { loggedIn?: unknown }) : undefined;
          return typeof body?.loggedIn === 'boolean' ? body.loggedIn : undefined;
        }
        return result.code === 0 && /logged in/i.test(`${result.stdout}${result.stderr}`);
      } catch {
        return undefined;
      }
    },
    attached: (command, args) => runAttached(command, args),
  };
}
