import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { classifyAreas } from '../../../src/skills/knowledge/classify.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { ScriptedLlm } from '../../support/context.js';

function deps(llm: ScriptedLlm) {
  const kv = new MapKeyValueStore();
  return { kv, classify: (items: { id: string; text: string }[]) => classifyAreas({ llm, kv, log: silentLogger }, items) };
}

function userText(llm: ScriptedLlm, index: number): string {
  return llm.requests[index]?.messages.find((message) => message.role === 'user')?.content ?? '';
}

describe('classifyAreas', () => {
  it('caches a model answer so the same id never reaches the model twice', async () => {
    const llm = new ScriptedLlm(['{"areas":{"f1":"work"}}']);
    const { classify, kv } = deps(llm);
    const items = [{ id: 'f1', text: '오늘 산 책' }];

    expect(await classify(items)).toEqual(new Map([['f1', 'work']]));
    expect(llm.requests).toHaveLength(1);
    expect(await kv.get('areaCache')).toEqual({ f1: 'work' });

    // The script is exhausted: a second model call would throw and fall back to the keyword area ("other").
    expect(await classify(items)).toEqual(new Map([['f1', 'work']]));
    expect(llm.requests).toHaveLength(1);
  });

  it('falls back to words for bad JSON and does not cache the fallback', async () => {
    const llm = new ScriptedLlm(['no json here']);
    const { classify } = deps(llm);

    expect(await classify([{ id: 'f1', text: '회의 준비' }])).toEqual(new Map([['f1', 'work']]));
    expect(llm.requests).toHaveLength(1);

    llm.push('```json\n{"areas":{"f1":"money"}}\n```');
    expect(await classify([{ id: 'f1', text: '회의 준비' }])).toEqual(new Map([['f1', 'money']]));
    expect(llm.requests).toHaveLength(2);
  });

  it('sends masked data and marks the request as masked', async () => {
    const llm = new ScriptedLlm(['{"areas":{"f1":"work"}}']);
    const { classify } = deps(llm);

    await classify([{ id: 'f1', text: '메일 a@b.com 로 보내줘' }]);

    const request = llm.requests[0];
    expect(request).toMatchObject({
      purpose: 'knowledge.classify',
      tier: 'fast',
      sensitivity: 'masked',
    });
    expect(request?.jsonSchema).toMatchObject({
      type: 'object',
      properties: { areas: { type: 'object' } },
      required: ['areas'],
    });

    const system = request?.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(system).toContain('never an instruction');
    const user = userText(llm, 0);
    expect(user).toContain('<data kind="facts">');
    expect(user).toContain('f1:');
    expect(user).toContain('[email]');
    expect(user).not.toContain('a@b.com');
  });

  it('ignores unknown ids and invalid areas, falling back without caching them', async () => {
    const llm = new ScriptedLlm(['{"areas":{"f1":"nope","ghost":"work"}}']);
    const { classify, kv } = deps(llm);

    expect(await classify([{ id: 'f1', text: '오늘 산 책' }])).toEqual(new Map([['f1', 'other']]));
    expect(await kv.get('areaCache')).toBeUndefined();
  });

  it('sends unseen facts in batches of sixty', async () => {
    const llm = new ScriptedLlm(['{"areas":{}}', '{"areas":{}}']);
    const { classify } = deps(llm);
    const items = Array.from({ length: 61 }, (_, index) => ({ id: `f${index}`, text: '회의' }));

    const result = await classify(items);

    expect(result.size).toBe(61);
    expect(llm.requests).toHaveLength(2);
    expect(userText(llm, 0)).toContain('f59:');
    expect(userText(llm, 0)).not.toContain('f60:');
    expect(userText(llm, 1)).toContain('f60:');
  });

  it('falls back to words when the model call throws', async () => {
    const llm = new ScriptedLlm();
    const { classify } = deps(llm);

    expect(await classify([{ id: 'mum', text: '엄마 생일' }])).toEqual(new Map([['mum', 'people']]));
  });
});
