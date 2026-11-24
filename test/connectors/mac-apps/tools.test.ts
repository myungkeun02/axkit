import { describe, expect, it } from 'vitest';
import type { ActResult, MacAppsClient, RunningApp, TargetStep, WindowSnapshot } from '../../../src/connectors/mac-apps/client.js';
import { macAppsChecks, macAppsConnector } from '../../../src/connectors/mac-apps/plugin.js';
import type { ToolCallContext } from '../../../src/core/tools/types.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const NOTES: RunningApp = { name: '메모', bundle: 'com.apple.Notes', pid: 1, active: true, hidden: false };
const TERMINAL: RunningApp = { name: '터미널', bundle: 'com.apple.Terminal', pid: 2, active: false, hidden: false };
const ONEPASS: RunningApp = { name: '1Password', bundle: 'com.1password.1password', pid: 3, active: false, hidden: false };
const DISGUISED_BANK: RunningApp = { name: 'Vault', bundle: 'com.kakaobank.vault', pid: 4, active: false, hidden: false };

class FakeClient implements MacAppsClient {
  readonly calls: string[] = [];
  apps_: RunningApp[] = [NOTES, TERMINAL, ONEPASS, DISGUISED_BANK];
  async trusted(): Promise<boolean> {
    return true;
  }
  async apps(): Promise<RunningApp[]> {
    return this.apps_;
  }
  async window(opts: { bundle?: string; redact?: boolean }): Promise<WindowSnapshot> {
    this.calls.push(`window ${opts.bundle ?? '-'} redact=${String(opts.redact === true)}`);
    const app = this.apps_.find((entry) => entry.bundle === opts.bundle) ?? NOTES;
    return {
      app,
      window: '창',
      truncated: false,
      nodes: [
        { depth: 0, role: 'AXWindow', subrole: '', label: '창', value: '', secure: false, disabled: false, focused: false },
        { depth: 1, role: 'AXTextField', subrole: '', label: '제목', value: '비밀 값', secure: false, disabled: false, focused: false },
      ],
    };
  }
  async selected(bundle?: string): Promise<{ app: RunningApp; text: string }> {
    this.calls.push(`selected ${bundle ?? '-'}`);
    return { app: NOTES, text: '고른 글' };
  }
  private done(what: string, label = ''): ActResult {
    this.calls.push(what);
    return { app: NOTES, role: 'AXButton', label };
  }
  async activate(bundle: string): Promise<ActResult> {
    return this.done(`activate ${bundle}`);
  }
  async press(bundle: string, target: readonly TargetStep[]): Promise<ActResult> {
    return this.done(`press ${bundle} ${JSON.stringify(target)}`, target.at(-1)?.title);
  }
  async set(bundle: string, target: readonly TargetStep[], value: string): Promise<ActResult> {
    return this.done(`set ${bundle} ${JSON.stringify(target)} ${value}`);
  }
  async menu(bundle: string, items: readonly string[]): Promise<ActResult> {
    return this.done(`menu ${bundle} ${items.join('>')}`);
  }
}

const MESSAGE = '메모 앱에서 저장 버튼 눌러 줘';
const asked = (message = MESSAGE): ToolCallContext => ({
  grounding: [message],
  conversation: { channelId: 'discord', address: 'dm' },
});

async function setup(answer: 'approved' | 'denied' = 'approved') {
  const client = new FakeClient();
  const confirmer = new FakeConfirmer(answer);
  const context = createTestContext({ confirmer });
  await macAppsConnector({ client }).setup(context.ctx);
  return { client, confirmer, tools: context.ctx.tools };
}

describe('mac.act', () => {
  it('always asks with a card that shows app, element and value, even for a plain write', async () => {
    const { client, confirmer, tools } = await setup();
    const outcome = await tools.execute(
      'mac.act',
      { app: '메모', action: 'set', target: ['AXTextField[제목]'], value: '회의록', evidence: '메모 앱에서' },
      asked(),
    );
    expect(outcome.status).toBe('done');
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.summary).toBe('앱: 메모\n동작: 글 넣기\n대상: AXTextField[제목]\n넣을 글: 회의록');
    expect(confirmer.requests[0]?.note).toContain('다른 앱을 대신 조작해요');
    expect(confirmer.requests[0]?.remember).toBeUndefined();
    expect(client.calls).toEqual(['set com.apple.Notes [{"role":"AXTextField","title":"제목"}] 회의록']);
  });

  it('does nothing when the owner says no', async () => {
    const { client, tools } = await setup('denied');
    const outcome = await tools.execute(
      'mac.act',
      { app: 'com.apple.Notes', action: 'press', target: ['AXButton[저장]'], evidence: '저장 버튼 눌러' },
      asked(),
    );
    expect(outcome.status).toBe('denied');
    expect(client.calls).toEqual([]);
  });

  it('marks a send button as send and a menu item that deletes as delete', async () => {
    const { confirmer, tools } = await setup();
    await tools.execute('mac.act', { app: '메모', action: 'press', target: ['AXButton[보내기]'], evidence: '메모 앱에서' }, asked());
    await tools.execute('mac.act', { app: '메모', action: 'menu', menu: ['편집', '삭제'], evidence: '메모 앱에서' }, asked());
    expect(confirmer.requests[0]?.effects).toEqual(['write', 'send']);
    expect(confirmer.requests[1]?.effects).toEqual(['write', 'delete']);
    expect(confirmer.requests[1]?.summary).toContain('메뉴: 편집 > 삭제');
  });

  it.each([
    [{ app: '토스', action: 'press', target: ['AXButton[송금]'] }, '읽기만'],
    [{ app: '1Password', action: 'set', target: ['AXTextField[검색]'], value: 'x' }, '읽기만'],
    [{ app: '메모', action: 'set', target: ['AXSecureTextField'], value: 'hunter2' }, '비밀번호 칸'],
    [{ app: '메모', action: 'set', target: ['AXTextField[비밀번호]'], value: 'hunter2' }, '비밀번호'],
    [{ app: '터미널', action: 'set', target: ['AXTextArea'], value: 'rm -rf ~\n' }, '줄바꿈'],
    [{ app: '메모', action: 'press' }, 'target'],
    [{ app: '메모', action: 'press', target: ['button'] }, 'AXRole'],
    [{ app: '메모', action: 'set', target: ['AXTextField'] }, 'value'],
  ] as const)('refuses %o before asking', async (args, words) => {
    const { client, confirmer, tools } = await setup();
    const outcome = await tools.execute('mac.act', { ...args, evidence: '메모 앱에서' }, asked(`메모 앱에서 ${args.app}`));
    expect(outcome.status).toBe('rejected');
    expect(outcome.status === 'rejected' ? outcome.reason : '').toContain(words);
    expect(confirmer.requests).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it('acts only on what the owner asked for in this message', async () => {
    const { confirmer, tools } = await setup();
    const input = { app: '메모', action: 'press', target: ['AXButton[저장]'], evidence: '저장 버튼 눌러' };
    const job = await tools.execute('mac.act', input, { grounding: [MESSAGE] });
    const otherWords = await tools.execute('mac.act', input, asked('오늘 날씨 어때?'));
    // Words from an earlier turn or a page read this turn sit after the message and do not count.
    const earlier = await tools.execute('mac.act', input, {
      grounding: ['응', '저장 버튼 눌러 줘'],
      conversation: { channelId: 'discord', address: 'dm' },
    });
    expect([job.status, otherWords.status, earlier.status]).toEqual(['rejected', 'rejected', 'rejected']);
    expect(confirmer.requests).toEqual([]);
  });

  it('warns sharply on terminal and settings cards, and never runs without one', async () => {
    const { client, confirmer, tools } = await setup('denied');
    const outcome = await tools.execute(
      'mac.act',
      { app: '터미널', action: 'set', target: ['AXTextArea'], value: 'ls', evidence: '메모 앱에서' },
      asked(),
    );
    expect(outcome.status).toBe('denied');
    expect(confirmer.requests[0]?.note).toContain('명령으로 실행될 수 있으니');
    expect(client.calls).toEqual([]);
  });

  it('checks the real app again after approval, so a vague name cannot reach a bank', async () => {
    const { client, tools } = await setup();
    const outcome = await tools.execute(
      'mac.act',
      { app: 'Vault', action: 'press', target: ['AXButton[확인]'], evidence: '메모 앱에서' },
      asked(),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('읽기만');
    expect(client.calls).toEqual([]);
  });

  it('refuses an app that is not running instead of launching it', async () => {
    const { tools } = await setup();
    const outcome = await tools.execute('mac.act', { app: 'Pages', action: 'activate', evidence: '메모 앱에서' }, asked());
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('켜져 있지 않아요');
  });
});

describe('reading tools', () => {
  it('lists apps with what ax-kit may do there', async () => {
    const { tools } = await setup();
    const outcome = await tools.execute('mac.apps', {});
    expect(outcome.status === 'done' ? outcome.output : undefined).toEqual([
      { name: '메모', bundle: 'com.apple.Notes', active: true, control: 'ask' },
      { name: '터미널', bundle: 'com.apple.Terminal', active: false, control: 'ask' },
      { name: '1Password', bundle: 'com.1password.1password', active: false, control: 'read-only' },
      { name: 'Vault', bundle: 'com.kakaobank.vault', active: false, control: 'read-only' },
    ]);
  });

  it('reads the frontmost window as data, and a password manager without values', async () => {
    const { client, tools } = await setup();
    const front = await tools.execute('mac.read_window', {});
    const output = front.status === 'done' ? (front.output as { elements: string; app: string }) : undefined;
    expect(output?.app).toBe('메모');
    expect(output?.elements).toContain('<data kind="mac.window">');
    expect(output?.elements).toContain('AXTextField[제목] = "비밀 값"');

    const vault = await tools.execute('mac.read_window', { app: '1Password' });
    const secret = vault.status === 'done' ? (vault.output as { elements: string; note?: string }) : undefined;
    expect(secret?.elements).not.toContain('비밀 값');
    expect(secret?.note).toContain('읽기만');
    expect(client.calls).toEqual(['window com.apple.Notes redact=false', 'window com.1password.1password redact=true']);
  });

  it('reads selected text, never from a password manager', async () => {
    const { client, tools } = await setup();
    const notes = await tools.execute('mac.selected_text', { app: '메모' });
    expect(notes.status === 'done' ? (notes.output as { text: string }).text : '').toContain('고른 글');
    const vault = await tools.execute('mac.selected_text', { app: '1Password' });
    expect(vault.status === 'done' ? vault.output : undefined).toEqual({ app: '1Password', text: '' });
    expect(client.calls).toEqual(['selected com.apple.Notes']);
  });
});

describe('macAppsChecks', () => {
  const runner = (code: number): ProcessRunner => async () => ({ code, stdout: 'swift 6\n', stderr: '', timedOut: false });

  it('stops at swiftc when the compiler is missing', async () => {
    const checks = await macAppsChecks(runner(1), new FakeClient());
    expect(checks).toEqual([{ id: 'mac-apps.swiftc', ok: false, detail: 'swiftc is not installed', fix: 'xcode-select --install' }]);
  });

  it('passes when Accessibility is allowed', async () => {
    const checks = await macAppsChecks(runner(0), new FakeClient());
    expect(checks.map((check) => check.ok)).toEqual([true, true]);
  });
});
