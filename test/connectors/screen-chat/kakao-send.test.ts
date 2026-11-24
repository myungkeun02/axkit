import { describe, expect, it } from 'vitest';
import { kakaoDesktopConnector } from '../../../src/connectors/screen-chat/plugin-kakao.js';
import type { KakaoSendDeps } from '../../../src/connectors/screen-chat/send-kakao.js';
import { kakaoSendTool } from '../../../src/connectors/screen-chat/send-kakao.js';
import type { ToolRunContext } from '../../../src/core/tools/types.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';
import type { RunHandler } from './helpers.js';
import { FakeAxReader, HOME, axSnapshot, fakeRunner, okResult, RecordingLogger } from './helpers.js';

const CHATS = {
  chats: [{ chat_id: 'c1', title: 'Example Coffee', last_message: 'hello' }],
};

interface SetupOptions {
  chats?: unknown;
  running?: boolean;
  existing?: readonly string[];
  dirs?: Record<string, readonly string[]>;
  kmsgPath?: string;
  handler?: RunHandler;
}

function setup(options: SetupOptions = {}) {
  const existing = new Set(options.existing ?? ['/opt/homebrew/bin/kmsg']);
  const chats = options.chats ?? CHATS;
  const { run, calls } = fakeRunner(
    options.handler ??
      ((_cmd, args) => (args[0] === 'chats' ? okResult(`starting\n${JSON.stringify(chats)}`) : okResult())),
  );
  const reader = new FakeAxReader();
  reader.snapshot = axSnapshot([], { running: options.running ?? true });
  const deps: KakaoSendDeps = {
    run,
    reader,
    home: HOME,
    exists: async (path) => existing.has(path),
    listDir: async (path) => [...(options.dirs?.[path] ?? [])],
    ...(options.kmsgPath !== undefined ? { kmsgPath: options.kmsgPath } : {}),
  };
  const context: ToolRunContext = {
    log: new RecordingLogger(),
    signal: new AbortController().signal,
    call: { grounding: [] },
  };
  return { tool: kakaoSendTool(deps), calls, reader, context, existing };
}

describe('kakao.send', () => {
  it('finds kmsg at the Homebrew path and sends by chat id', async () => {
    const { tool, calls, context } = setup();

    const output = await tool.run({ room: 'Example Coffee', text: '안녕하세요' }, context);

    expect(output).toEqual({ sent: true, room: 'Example Coffee' });
    expect(calls[0]?.cmd).toBe('/opt/homebrew/bin/kmsg');
    expect(calls[0]?.args).toEqual(['chats', '--json']);
    expect(calls[1]?.args).toEqual(['send', '--chat-id', 'c1', '안녕하세요']);
    expect(calls[1]?.args).not.toContain('Example Coffee');
  });

  it('falls back to /usr/local/bin/kmsg', async () => {
    const { tool, calls, context } = setup({ existing: ['/usr/local/bin/kmsg'] });
    await tool.run({ room: 'Example Coffee', text: 'hi' }, context);
    expect(calls[0]?.cmd).toBe('/usr/local/bin/kmsg');
  });

  it('uses an explicit kmsg path', async () => {
    const { tool, calls, context } = setup({ kmsgPath: '/custom/bin/kmsg', existing: [] });
    await tool.run({ room: 'Example Coffee', text: 'hi' }, context);
    expect(calls[0]?.cmd).toBe('/custom/bin/kmsg');
  });

  it('refuses when kmsg is not installed', async () => {
    const { tool, context } = setup({ existing: [] });
    await expect(tool.run({ room: 'Example Coffee', text: 'hi' }, context)).rejects.toThrow(
      'kmsg is not installed (brew install channprj/tap/kmsg)',
    );
  });

  it('refuses when kmsg has a saved credentials file', async () => {
    const { tool, context, calls, reader } = setup({
      existing: ['/opt/homebrew/bin/kmsg', `${HOME}/.config/kmsg/credentials.json`],
    });

    await expect(tool.run({ room: 'Example Coffee', text: 'hi' }, context)).rejects.toThrow(
      /never logs in/,
    );
    expect(calls).toHaveLength(0);
    expect(reader.dumpCalls).toHaveLength(0);
  });

  it('refuses when kmsg has a non-empty credentials directory', async () => {
    const credentials = `${HOME}/.config/kmsg/credentials`;
    const { tool, context, calls } = setup({
      existing: ['/opt/homebrew/bin/kmsg', credentials],
      dirs: { [credentials]: ['saved-password'] },
    });

    await expect(tool.run({ room: 'Example Coffee', text: 'hi' }, context)).rejects.toThrow(
      /never logs in/,
    );
    expect(calls).toHaveLength(0);
  });

  it('allows an empty credentials directory', async () => {
    const credentials = `${HOME}/.config/kmsg/credentials`;
    const { tool, context } = setup({
      existing: ['/opt/homebrew/bin/kmsg', credentials],
      dirs: { [credentials]: [] },
    });

    await expect(tool.run({ room: 'Example Coffee', text: 'hi' }, context)).resolves.toEqual({
      sent: true,
      room: 'Example Coffee',
    });
  });

  it('refuses to send while KakaoTalk is not running', async () => {
    const { tool, context, calls } = setup({ running: false });

    await expect(tool.run({ room: 'Example Coffee', text: 'hi' }, context)).rejects.toThrow(
      /never launches/,
    );
    expect(calls).toHaveLength(0);
  });

  it('matches the room title exactly, never fuzzily', async () => {
    const options: SetupOptions = {
      chats: {
        chats: [
          { chat_id: 'c1', title: 'Example Coffee Shop', last_message: 'hello' },
          { chat_id: 'c2', title: 'Example Coffee', last_message: 'hello' },
        ],
      },
    };

    const ambiguousSetup = setup(options);
    await expect(
      ambiguousSetup.tool.run({ room: 'Example Coff', text: 'hi' }, ambiguousSetup.context),
    ).rejects.toThrow(/No KakaoTalk room/);
    await expect(
      ambiguousSetup.tool.run({ room: 'Example Coffee', text: 'hi' }, ambiguousSetup.context),
    ).resolves.toEqual({ sent: true, room: 'Example Coffee' });
  });

  it('refuses an ambiguous room title', async () => {
    const { tool, context } = setup({
      chats: {
        chats: [
          { chat_id: 'c1', title: 'Example Coffee', last_message: 'a' },
          { chat_id: 'c2', title: 'Example Coffee', last_message: 'b' },
        ],
      },
    });

    await expect(tool.run({ room: 'Example Coffee', text: 'hi' }, context)).rejects.toThrow(
      /More than one KakaoTalk room/,
    );
  });

  it('matches titles after NFC normalization', async () => {
    const { tool, context } = setup({
      chats: { chats: [{ chat_id: 'c1', title: 'Example Café', last_message: 'hello' }] },
    });

    await expect(tool.run({ room: 'Example Café', text: 'hi' }, context)).resolves.toEqual({
      sent: true,
      room: 'Example Café',
    });
  });

  it('fails clearly when kmsg returns no JSON or a bad list', async () => {
    const noJson = setup({ handler: () => okResult('nothing here') });
    await expect(noJson.tool.run({ room: 'Example Coffee', text: 'hi' }, noJson.context)).rejects.toThrow(
      /did not return chat data/,
    );

    const badJson = setup({
      handler: (_cmd, args) => (args[0] === 'chats' ? okResult('{not json') : okResult()),
    });
    await expect(badJson.tool.run({ room: 'Example Coffee', text: 'hi' }, badJson.context)).rejects.toThrow(
      /invalid chat data/,
    );
  });

  it('fails clearly when kmsg exits non-zero or times out', async () => {
    const failed = setup({
      handler: (_cmd, args) =>
        args[0] === 'chats' ? { code: 1, stdout: '', stderr: '', timedOut: false } : okResult(),
    });
    await expect(failed.tool.run({ room: 'Example Coffee', text: 'hi' }, failed.context)).rejects.toThrow(
      /failed with exit code 1/,
    );

    const timedOut = setup({
      handler: (_cmd, args) =>
        args[0] === 'chats' ? okResult(JSON.stringify(CHATS)) : { code: 0, stdout: '', stderr: '', timedOut: true },
    });
    await expect(
      timedOut.tool.run({ room: 'Example Coffee', text: 'hi' }, timedOut.context),
    ).rejects.toThrow(/timed out/);
  });

  it('describes the exact action for the confirmation card', () => {
    const { tool } = setup();
    expect(tool.describe?.({ room: 'Example Coffee', text: '안녕하세요' })).toBe(
      'KakaoTalk → Example Coffee\n안녕하세요',
    );
  });

  it('asks the confirmer when executed through the tool policy', async () => {
    const chats = JSON.stringify(CHATS);
    const { run } = fakeRunner((_cmd, args) =>
      args[0] === 'chats' ? okResult(chats) : okResult(),
    );
    const reader = new FakeAxReader();
    reader.snapshot = axSnapshot([], { running: true });
    const confirmer = new FakeConfirmer();
    const context = createTestContext({ confirmer });

    await kakaoDesktopConnector({
      run,
      reader,
      home: HOME,
      fs: { exists: async (path) => path === '/opt/homebrew/bin/kmsg', listDir: async () => [] },
    }).setup(context.ctx);

    const outcome = await context.ctx.tools.execute('kakao.send', {
      room: 'Example Coffee',
      text: '안녕하세요',
    });

    expect(outcome.status).toBe('done');
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.effects).toContain('send');
    expect(confirmer.requests[0]?.summary).toBe('KakaoTalk → Example Coffee\n안녕하세요');
  });
});
