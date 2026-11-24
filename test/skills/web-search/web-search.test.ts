import { describe, expect, it } from 'vitest';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { claudeWebSearcher, parseSearchResult } from '../../../src/skills/web-search/search.js';
import { webSearchSkill } from '../../../src/skills/web-search/plugin.js';
import { createTestContext } from '../../support/context.js';

describe('web search without the browser', () => {
  it('reads the answer as JSON, in fences, or as plain text with its links', () => {
    expect(parseSearchResult('```json\n{"answer":"ACME는 개발자 커뮤니티예요.","sources":[{"title":"ACME","url":"https://acme.kr"},{"url":"javascript:x"}]}\n```')).toEqual({
      answer: 'ACME는 개발자 커뮤니티예요.',
      sources: [{ title: 'ACME', url: 'https://acme.kr' }],
    });
    expect(parseSearchResult('찾은 내용: https://example.com/a 참고').sources).toEqual([{ title: 'https://example.com/a', url: 'https://example.com/a' }]);
  });

  it('runs the CLI with only its web tools, in an empty folder, with the prompt on stdin', async () => {
    const calls: { args: readonly string[]; input?: string; cwd?: string }[] = [];
    const run: ProcessRunner = async (_cmd, args, opts) => {
      calls.push({ args, ...(opts.input !== undefined ? { input: opts.input } : {}), ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
      return { code: 0, stdout: JSON.stringify({ is_error: false, result: '{"answer":"betalab은 …","sources":[]}' }), stderr: '', timedOut: false };
    };
    const out = await claudeWebSearcher(run)('betalab 회사', 'ko');
    expect(out.answer).toBe('betalab은 …');
    const args = calls[0]?.args.join(' ') ?? '';
    expect(args).toContain('--tools WebSearch,WebFetch');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('betalab');
    expect(calls[0]?.input).toContain('<query>\nbetalab 회사\n</query>');
    const failing: ProcessRunner = async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Not logged in' }), stderr: '', timedOut: false });
    await expect(claudeWebSearcher(failing)('x', 'ko')).rejects.toThrow('Not logged in');
  });

  it('gives the assistant web.search and web.read tools', async () => {
    const context = createTestContext({});
    await webSearchSkill({ searcher: async (query) => ({ answer: `${query}: 찾았어요`, sources: [] }) }).setup(context.ctx);
    const result = await context.ctx.tools.execute('web.search', { query: 'ACME 운영사' }, { grounding: [] });
    expect(result).toMatchObject({ status: 'done', output: { answer: 'ACME 운영사: 찾았어요' } });
    expect(context.ctx.tools.list().map((tool) => tool.name)).toContain('web.read');
  });
});
