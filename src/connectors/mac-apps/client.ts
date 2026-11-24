import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ensureSwiftHelper } from '../../core/process/swift-helper.js';
import type { ProcessRunner, RunResult } from '../../core/process/types.js';

const TIMEOUT_MS = 20_000;

export interface RunningApp {
  name: string;
  bundle: string;
  pid: number;
  active: boolean;
  hidden: boolean;
}

/** One element of the focused window, flattened in pre-order. */
export interface WindowNode {
  depth: number;
  role: string;
  subrole: string;
  label: string;
  value: string;
  secure: boolean;
  disabled: boolean;
  focused: boolean;
}

export interface WindowSnapshot {
  app: RunningApp;
  window: string;
  truncated: boolean;
  nodes: WindowNode[];
}

export interface TargetStep {
  role: string;
  title?: string;
}

export interface ActResult {
  app: RunningApp;
  role: string;
  label: string;
}

export type MacAppsErrorCode =
  | 'accessibility'
  | 'not-running'
  | 'not-found'
  | 'ambiguous'
  | 'secure'
  | 'disabled'
  | 'not-settable'
  | 'helper'
  | 'timeout';

const MESSAGES: Record<MacAppsErrorCode, string> = {
  accessibility:
    '손쉬운 사용 권한이 없어요. 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 ax-kit을 실행하는 앱(터미널 또는 node)을 허용한 뒤 ax-kit을 다시 시작해 주세요.',
  'not-running': '그 앱이 켜져 있지 않아요. 비서는 앱을 직접 실행하지 않아요.',
  'not-found': '그 대상을 화면에서 찾지 못했어요. 창을 다시 읽고 대상을 확인해 주세요.',
  ambiguous: '같은 대상이 여러 개라서 고르지 않았어요. 위쪽 요소를 함께 지정해 주세요.',
  secure: '비밀번호 칸은 읽거나 입력하지 않아요.',
  disabled: '그 버튼은 지금 누를 수 없는 상태예요.',
  'not-settable': '그 요소에는 글을 넣을 수 없어요.',
  helper: '앱 조작 도우미가 예상하지 못한 답을 줬어요.',
  timeout: '앱 조작 도우미가 제때 답하지 않았어요.',
};

export class MacAppsError extends Error {
  constructor(
    readonly code: MacAppsErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${detail})`);
    this.name = 'MacAppsError';
  }
}

const App = z.object({
  name: z.string(),
  bundle: z.string(),
  pid: z.number().int(),
  active: z.boolean(),
  hidden: z.boolean(),
});
const Failed = z.object({ ok: z.literal(false), error: z.string(), count: z.number().optional() });
const Trusted = z.object({ ok: z.literal(true), trusted: z.boolean() });
const Apps = z.object({ ok: z.literal(true), apps: z.array(App) });
const Node = z.tuple([z.number().int(), z.string(), z.string(), z.string(), z.string(), z.string()]);
const Window = z.object({
  ok: z.literal(true),
  app: App,
  window: z.string(),
  truncated: z.boolean(),
  nodes: z.array(Node),
});
const Selected = z.object({ ok: z.literal(true), app: App, text: z.string() });
const Done = z
  .object({ ok: z.literal(true), app: App, role: z.string().default(''), label: z.string().default('') })
  .transform(({ app, role, label }): ActResult => ({ app, role, label }));

const KNOWN: readonly string[] = Object.keys(MESSAGES);

/** The helper's commands. Every method is one process run; nothing is cached. */
export interface MacAppsClient {
  trusted(): Promise<boolean>;
  apps(): Promise<RunningApp[]>;
  window(opts: { bundle?: string; maxDepth?: number; maxNodes?: number; redact?: boolean }): Promise<WindowSnapshot>;
  selected(bundle?: string): Promise<{ app: RunningApp; text: string }>;
  activate(bundle: string): Promise<ActResult>;
  press(bundle: string, target: readonly TargetStep[]): Promise<ActResult>;
  set(bundle: string, target: readonly TargetStep[], value: string): Promise<ActResult>;
  menu(bundle: string, items: readonly string[]): Promise<ActResult>;
}

export interface HelperMacAppsClientOptions {
  run: ProcessRunner;
  helperPath: () => Promise<string>;
}

/** Runs the bundled ax-control helper and checks every document it prints. */
export class HelperMacAppsClient implements MacAppsClient {
  constructor(private readonly options: HelperMacAppsClientOptions) {}

  async trusted(): Promise<boolean> {
    return this.parse(await this.call(['trusted']), Trusted).trusted;
  }

  async apps(): Promise<RunningApp[]> {
    return this.parse(await this.call(['apps']), Apps).apps;
  }

  async window(opts: { bundle?: string; maxDepth?: number; maxNodes?: number; redact?: boolean }): Promise<WindowSnapshot> {
    const args = ['window'];
    if (opts.bundle !== undefined) args.push('--bundle', opts.bundle);
    if (opts.maxDepth !== undefined) args.push('--max-depth', String(opts.maxDepth));
    if (opts.maxNodes !== undefined) args.push('--max-nodes', String(opts.maxNodes));
    if (opts.redact === true) args.push('--redact', '1');
    const data = this.parse(await this.call(args), Window);
    return {
      app: data.app,
      window: data.window,
      truncated: data.truncated,
      nodes: data.nodes.map(([depth, role, subrole, label, value, flags]) => ({
        depth,
        role,
        subrole,
        label,
        // The helper already blanks secure fields; this keeps it so even if a future helper forgot.
        value: flags.includes('s') ? '' : value,
        secure: flags.includes('s'),
        disabled: flags.includes('d'),
        focused: flags.includes('f'),
      })),
    };
  }

  async selected(bundle?: string): Promise<{ app: RunningApp; text: string }> {
    const data = this.parse(await this.call(['selected', ...(bundle !== undefined ? ['--bundle', bundle] : [])]), Selected);
    return { app: data.app, text: data.text };
  }

  async activate(bundle: string): Promise<ActResult> {
    return this.parse(await this.call(['activate', '--bundle', bundle]), Done);
  }

  async press(bundle: string, target: readonly TargetStep[]): Promise<ActResult> {
    return this.parse(await this.call(['press', '--bundle', bundle, '--target', JSON.stringify(target)]), Done);
  }

  async set(bundle: string, target: readonly TargetStep[], value: string): Promise<ActResult> {
    const args = ['set', '--bundle', bundle, '--target', JSON.stringify(target), '--value', value];
    return this.parse(await this.call(args), Done);
  }

  async menu(bundle: string, items: readonly string[]): Promise<ActResult> {
    return this.parse(await this.call(['menu', '--bundle', bundle, '--items', JSON.stringify(items)]), Done);
  }

  private async call(args: readonly string[]): Promise<unknown> {
    const helper = await this.options.helperPath();
    let result: RunResult;
    try {
      result = await this.options.run(helper, args, { timeoutMs: TIMEOUT_MS });
    } catch (error) {
      throw new MacAppsError('helper', error instanceof Error ? error.message : String(error));
    }
    if (result.timedOut) throw new MacAppsError('timeout');
    if (result.code !== 0) throw new MacAppsError('helper', `exit ${result.code}`);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new MacAppsError('helper', 'invalid JSON');
    }
  }

  private parse<T>(raw: unknown, schema: z.ZodType<T>): T {
    const failed = Failed.safeParse(raw);
    if (failed.success) {
      const code = failed.data.error;
      if (KNOWN.includes(code)) throw new MacAppsError(code as MacAppsErrorCode);
      throw new MacAppsError('helper', code);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new MacAppsError('helper', 'unexpected document');
    return parsed.data;
  }
}

/** Memoized compile of ax-control.swift into `binDir`; a failed build is retried on the next call. */
export function macAppsHelperPath(binDir: string, run: ProcessRunner): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= ensureSwiftHelper(
      { name: 'ax-control', sourcePath: fileURLToPath(new URL('./ax-control.swift', import.meta.url)), binDir },
      { run },
    ).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
