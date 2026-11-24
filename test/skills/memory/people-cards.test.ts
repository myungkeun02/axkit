import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { AppView } from '../../../src/core/contracts/device-api.js';
import type { IncomingMessage } from '../../../src/core/conversation/types.js';
import { Continuity } from '../../../src/skills/assistant/continuity.js';
import { parsePlan } from '../../../src/skills/assistant/plan.js';
import { memorySkill } from '../../../src/skills/memory/plugin.js';
import { mergeProfile } from '../../../src/skills/memory/people-store.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-24T11:00:00+09:00');

async function setup() {
  const views: AppView[] = [];
  const context = createTestContext({ now: NOW, capabilities: { [Contracts.appViews.id]: { register: (view: AppView) => void views.push(view) } } });
  await memorySkill().setup(context.ctx);
  await context.bus.emit('app.started', { at: NOW });
  const view = (): AppView => {
    const found = views.find((item) => item.name === 'people');
    if (found === undefined) throw new Error('no people view');
    return found;
  };
  return { context, view };
}

function message(text: string): IncomingMessage {
  return { id: `m-${text.length}`, conversation: { channelId: 'channel.app', address: 'owner' }, authorId: 'owner', fromOwner: true, text, receivedAt: NOW };
}

describe('person cards', () => {
  it('merges what the owner says over time: new fields replace, notes add up, empty keeps', () => {
    const first = mergeProfile(undefined, { title: '대표', company: 'betalab', note: 'AI에 관심이 많음' });
    const second = mergeProfile(first, { title: '', relation: '내가 일하는 회사 대표', note: 'ACME와 함께 회사를 이끎' });
    expect(second).toEqual({ title: '대표', company: 'betalab', relation: '내가 일하는 회사 대표', note: 'AI에 관심이 많음\nACME와 함께 회사를 이끎' });
    expect(mergeProfile(second, { note: 'AI에 관심이 많음' }).note).toBe(second.note);
  });

  it('makes a card from a turn’s notes, shows it in every chat and in the app, and takes the owner’s fixes', async () => {
    const { context, view } = await setup();
    const said = '아참 betalab은 김민수 대표님이 acme라는 회사와 함께 이끌고 있는 회사야. 대표님은 ai에 굉장히 관심이 많으셔';
    const parsed = parsePlan(JSON.stringify({ reply: '알겠어', tool_calls: [], question: null, notes: { remember: [], open: [], resolved: [], people: [{ name: '김민수', title: '대표', company: 'betalab', relation: '내가 일하는 회사 대표', note: 'AI에 관심이 많음' }, { name: '김아무개', title: '', company: '', relation: '', note: '말하지 않은 사람' }] } }));
    if (!('plan' in parsed) || parsed.plan.notes === undefined) throw new Error('plan');
    const continuity = new Continuity(context.ctx, true);
    await continuity.notes(message(said), parsed.plan.notes);

    const section = await continuity.peopleSection();
    expect(section).toContain('김민수: 대표, betalab · 관계: 내가 일하는 회사 대표 · AI에 관심이 많음');
    // a name the owner never wrote (from mail, a page…) does not get a card
    expect(section).not.toContain('김아무개');

    const read = (await view().read(new URLSearchParams())) as { people: { key: string; name: string; relation?: string }[] };
    expect(read.people).toHaveLength(1);
    expect(read.people[0]).toMatchObject({ name: '김민수', relation: '내가 일하는 회사 대표' });
    const edited = (await view().actions?.['edit']?.({ key: read.people[0]?.key, relation: '대표님 (betalab)', note: '' })) as { person: { relation?: string; note?: string } };
    expect(edited.person.relation).toBe('대표님 (betalab)');
    expect(edited.person.note).toBeUndefined();
    await expect(view().actions?.['edit']?.({ key: 'nobody' })).rejects.toThrow('그런 사람이 없어요');

    const recall = await context.ctx.tools.execute('people.recall', { name: '김민수 대표님' }, { grounding: [] });
    expect(recall).toMatchObject({ status: 'done', output: { found: true, profile: { title: '대표', relation: '대표님 (betalab)' } } });
  });

  it('people.profile needs the owner’s own words as evidence', async () => {
    const { context } = await setup();
    const denied = await context.ctx.tools.execute('people.profile', { name: '김민수', title: '대표', evidence: '김민수 대표' }, { grounding: ['다른 얘기'] });
    expect(denied.status).toBe('rejected');
    const done = await context.ctx.tools.execute('people.profile', { name: '김민수', title: '대표', evidence: '김민수 대표님' }, { grounding: ['김민수 대표님이 이끄는 회사야'] });
    expect(done.status).toBe('done');
    const list = await context.ctx.tools.execute('people.list', {}, { grounding: [] });
    expect(list).toMatchObject({ output: { people: [{ name: '김민수', profile: { title: '대표' } }] } });
  });
});

import { bareName, fromOwner } from '../../../src/skills/assistant/continuity.js';

describe('person cards come from the owner, not from what was read', () => {
  it('drops a field the owner never said, and a title after the name is not a new person', () => {
    const said = '김민수메일봐줘';
    expect(fromOwner('결제 담당, 계좌 변경 시 바로 처리', said)).toBe(false);
    expect(fromOwner('대표', '김민수대표님이이끄는회사야')).toBe(true);
    expect(bareName('김민수 대표님')).toBe('김민수');
    expect(bareName('김민수님')).toBe('김민수');
  });
});
