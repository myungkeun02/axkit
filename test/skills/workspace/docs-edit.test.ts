import { describe, expect, it } from 'vitest';
import type { DocsEditor, DocsReader, DocsWriter } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { workspaceSkill } from '../../../src/skills/workspace/plugin.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const DOC_ID = '1AbCdEfGhIjKlMnOp';

function fakes() {
  const calls: string[] = [];
  const reader: DocsReader = {
    async read(id) {
      return { id, title: '계약서', text: '## 본문\n금액은 100만원\n', truncated: false, url: 'u' };
    },
  };
  const writer: DocsWriter = {
    async append(id, text, target) {
      calls.push(`append:${id}:${target?.tab ?? '-'}:${text}`);
      return { id, url: 'u' };
    },
    async create() {
      return { id: 'new', url: 'u' };
    },
  };
  const editor: DocsEditor = {
    async replaceText(id, find, replace, target) {
      calls.push(`replace:${id}:${target?.tab ?? '-'}:${find}>${replace}`);
      return { id, url: 'u', replaced: 1 };
    },
  };
  return { calls, reader, writer, editor };
}

async function setup(level: 'read' | 'create' | 'edit') {
  const f = fakes();
  const confirmer = new FakeConfirmer();
  const context = createTestContext({
    confirmer,
    policy: { confirmWrites: true, expiresMinutes: 30 },
    capabilities: { [Contracts.docsRead.id]: f.reader, [Contracts.docsWrite.id]: f.writer, [Contracts.docsEdit.id]: f.editor },
  });
  const plugin = workspaceSkill({ docs: true, docsLevel: level });
  await plugin.setup(context.ctx);
  const run = (name: string, input: unknown) => context.ctx.tools.execute(name, input, { grounding: [] });
  return { ...f, plugin, context, confirmer, run };
}

describe('Docs levels in the workspace skill', () => {
  it('registers docs.read only, the create tools, or also docs.replace_text', async () => {
    const names = async (level: 'read' | 'create' | 'edit') => (await setup(level)).context.registry.list().map((tool) => tool.name);
    expect(await names('read')).toEqual(['docs.read']);
    expect(await names('create')).toEqual(['docs.read', 'docs.append', 'docs.create']);
    expect(await names('edit')).toEqual(['docs.read', 'docs.append', 'docs.create', 'docs.replace_text']);
    expect((await setup('read')).plugin.manifest.needs).toEqual([Contracts.docsRead]);
    const append = (await setup('edit')).context.registry.list().find((tool) => tool.name === 'docs.append');
    expect(append?.description).not.toContain('Only documents ax-kit created');
  });

  it('shows the doc, the tab and the text on the append card', async () => {
    const { run, confirmer, calls } = await setup('edit');
    await run('docs.read', { doc: DOC_ID });

    await run('docs.append', { doc: DOC_ID, text: '부록 추가', tab: '본문' });
    await run('docs.append', { doc: DOC_ID, text: '끝' });

    expect(confirmer.requests[0]?.summary).toContain('Google 문서에 글 덧붙이기: 계약서\n위치: "본문" 탭 끝');
    expect(confirmer.requests[1]?.summary).toContain('위치: 문서 끝 (첫 번째 탭)');
    expect(calls).toEqual([`append:${DOC_ID}:본문:\n부록 추가`, `append:${DOC_ID}:-:\n끝`]);
  });

  it('shows the phrase before and after on the replace card', async () => {
    const { run, confirmer, calls } = await setup('edit');
    await run('docs.read', { doc: DOC_ID });

    const outcome = await run('docs.replace_text', { doc: DOC_ID, find: '100만원', replace: '120만원' });

    expect(outcome).toMatchObject({ status: 'done', output: { replaced: 1 } });
    const card = confirmer.requests[0]?.summary ?? '';
    expect(card).toContain('Google 문서 고치기: 계약서');
    expect(card).toContain('위치: 첫 번째 탭');
    expect(card).toContain('바꿀 문구: 100만원');
    expect(card).toContain('새 문구: 120만원');
    expect(calls).toEqual([`replace:${DOC_ID}:-:100만원>120만원`]);
    expect(await run('docs.replace_text', { doc: DOC_ID, find: '두 줄\n문구', replace: 'x' })).toMatchObject({ status: 'invalid_input' });
  });
});
