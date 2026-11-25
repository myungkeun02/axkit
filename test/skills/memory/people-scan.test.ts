import { describe, expect, it } from 'vitest';
import { PeopleStore } from '../../../src/skills/memory/people-store.js';
import { OrgUnitStore } from '../../../src/skills/memory/people-units.js';
import { peopleView } from '../../../src/skills/memory/tools-people-card.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';

describe('person cards from the first look', () => {
  it('fills empty fields, updates what a scan wrote, and never overwrites the owner', async () => {
    const people = new PeopleStore(new MapKeyValueStore(), new FakeClock(new Date('2026-11-25T00:00:00Z')));
    await people.fillFromScan({ name: '김민수', email: 'minsu@a.co' }, { title: '매니저', team: '마케팅팀', company: '에이컴퍼니' });
    await people.editProfile('김민수', { title: '팀장' });
    await people.fillFromScan({ email: 'minsu@a.co' }, { title: '매니저', team: '브랜드팀', relation: '같은 회사 동료' });
    const [card] = await people.cards();
    expect(card?.profile).toEqual({ title: '팀장', company: '에이컴퍼니', team: '브랜드팀', relation: '같은 회사 동료' });
  });

  it('shows scanned people and the units in the 사람 view', async () => {
    const kv = new MapKeyValueStore();
    const people = new PeopleStore(kv, new FakeClock(new Date('2026-11-25T00:00:00Z')));
    const units = new OrgUnitStore(kv);
    await people.fillFromScan({ name: '이지은' }, { team: '마케팅팀', note: '처음 알아보기: 문서 2개에서 봤어요.' });
    await units.replace([{ org: '에이컴퍼니', name: '마케팅팀', lead: '이지은', members: ['이지은'], sources: ['조직도'], roles: [{ title: 'x', does: 'y' }] }]);
    const read = (await peopleView(people, '사람', units).read(new URLSearchParams())) as { people: { name: string; team?: string }[]; units: unknown[] };
    expect(read.people).toMatchObject([{ name: '이지은', team: '마케팅팀' }]);
    expect(read.units).toEqual([{ org: '에이컴퍼니', name: '마케팅팀', lead: '이지은', members: ['이지은'], sources: ['조직도'] }]);
  });
});
