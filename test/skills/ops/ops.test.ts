import { describe, expect, it } from 'vitest';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { macCheckTool, macRunTool } from '../../../src/skills/ops/plugin.js';
import { isOpsRequest } from '../../../src/skills/self-dev/ops-room.js';
import { createTestContext } from '../../support/context.js';

describe('operating this Mac from chat', () => {
  it('looks with fixed commands only, and every change asks on a card', async () => {
    const ran: string[] = [];
    const run: ProcessRunner = async (_cmd, args) => (ran.push(args[1] ?? ''), { code: 0, stdout: 'ok token=sk-ant-abcdefghijklmnopqrstuvwxyz0123', stderr: '', timedOut: false });
    const check = await macCheckTool(run).run({ what: ['disk'] }, {} as never);
    expect(ran[0]).toBe('df -h / | tail -n 1');
    expect(check.results[0]?.output).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    const tool = macRunTool(run);
    expect(tool.effects).toEqual(['system']);
    expect(tool.reject?.({ command: 'sudo rm -rf /x', why: 'x' }, {} as never)).toContain('refused');
    expect(tool.reject?.({ command: 'security find-generic-password -s x', why: 'x' }, {} as never)).toContain('refused');
    expect(tool.reject?.({ command: 'brew install ffmpeg', why: '받아쓰기' }, {} as never)).toBeUndefined();
  });

  it('sends operating requests in the ax 개선 room to an ops sub-session, code requests to the coder', async () => {
    const { ctx } = createTestContext({});
    expect(await isOpsRequest(ctx, 'Aside 도구 설치해 줘')).toBe(true);
    expect(await isOpsRequest(ctx, '설정 화면 문구 바꿔 줘')).toBe(false);
  });
});
