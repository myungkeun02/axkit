import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { SmsReaderClaims } from '../../../src/core/contracts/index.js';
import { autonomyKey, topicFor } from '../../../src/skills/sms-reader/actions.js';
import { PARCEL_JOB } from '../../../src/skills/sms-reader/parcels.js';
import { ScriptedLlm } from '../../support/context.js';
import { NOW, setup } from './helpers.js';

const BOOKING = '[예시치과] 홍길동님 12월 3일(수) 오후 2시 30분 진료 예약이 확정되었습니다.';
const BILL = '[KT] 11월 이용요금 52,300원 납부기한 12월 25일까지';
const PARCEL = '[CJ대한통운] 상품이 배송 출발했습니다. 운송장번호 : 6123-4567-8901';
const SMISHING = '[CJ대한통운] 주소지 불명으로 반송 예정입니다. 주소 확인 http://cj-logis.top/a1';

describe('sms-reader cards and actions', () => {
  it('asks once about a reservation and adds the quoted event on yes', async () => {
    const context = await setup();
    await context.send({ text: BOOKING, from: '0212345678', ref: 'sms:abc' });
    await context.send({ text: BOOKING, from: '0212345678', ref: 'sms:abc' });

    expect(context.confirmer.requests).toHaveLength(1);
    const card = context.confirmer.requests[0]!;
    expect(card.topic).toBe('sms:reservation:abc');
    expect(card.summary).toBe("'예시치과 예약' 일정을 캘린더에 넣을까요?");
    expect(card.note).toContain('"12월 3일(수) 오후 2시 30분"');
    expect(card.choices?.map((choice) => choice.id)).toEqual(['yes', 'later', 'no']);
    expect(context.calls).toEqual([
      {
        name: 'calendar.add_event',
        input: {
          title: '예시치과 예약',
          date: { kind: 'month_day', month: 12, day: 3 },
          time: { hour: 2, minute: 30, meridiem: 'pm' },
          evidence: '12월 3일(수) 오후 2시 30분',
        },
        grounding: [BOOKING],
      },
    ]);
    expect(context.notifier.notices.at(-1)?.text).toBe("'예시치과 예약' 일정을 캘린더에 넣었어요.");
  });

  it('creates nothing when the owner says no', async () => {
    const context = await setup({ answer: 'denied' });
    await context.send({ text: BILL, from: '114' });
    expect(context.confirmer.requests[0]?.summary).toBe("'KT 납부 52,300원'을 할 일에 넣을까요? 결제는 하지 않아요.");
    expect(context.calls).toHaveLength(0);
  });

  it('adds a bill as a to-do with the due date and amount', async () => {
    const context = await setup();
    await context.send({ text: BILL, from: '114', ref: 'sms:bill1' });
    expect(context.confirmer.requests[0]?.topic).toBe('sms:bill:bill1');
    expect(context.calls[0]).toMatchObject({
      name: 'todo.add',
      input: { text: 'KT 납부 52,300원', due: { date: { kind: 'month_day', month: 12, day: 25 } }, evidence: '12월 25일' },
    });
  });

  it('follows a parcel on yes and reports changes until delivery', async () => {
    const context = await setup();
    context.parcelReplies.push({ state: '집하', delivered: false });
    await context.send({ text: PARCEL, from: '15881255' });
    expect(context.calls[0]).toMatchObject({ name: 'life.parcel', input: { carrier: 'CJ대한통운', invoice: '612345678901' } });
    expect(context.notifier.notices.at(-1)?.text).toBe('CJ대한통운 택배: 집하');

    context.parcelReplies.push({ state: '배송출발', delivered: false }, { state: '배송완료', delivered: true });
    await context.scheduler.run(PARCEL_JOB, NOW);
    expect(context.notifier.notices.at(-1)?.text).toBe('CJ대한통운 택배: 배송출발');
    await context.scheduler.run(PARCEL_JOB, NOW);
    expect(context.notifier.notices.at(-1)?.text).toContain('배송 완료');
    expect(await context.kv.get('parcels')).toEqual([]);
  });

  it('does not offer to follow a parcel without the parcel lookup', async () => {
    const context = await setup({ parcel: false });
    await context.send({ text: PARCEL });
    expect(context.confirmer.requests).toHaveLength(0);
  });

  it('a cancelled booking only gets a notice', async () => {
    const context = await setup();
    await context.send({ text: '[예시미용실] 11/28 예약이 취소되었습니다' });
    expect(context.confirmer.requests).toHaveLength(0);
    expect(context.calls).toHaveLength(0);
    expect(context.notifier.notices[0]?.text).toContain("'예시미용실 예약'이 취소됐다는 문자");
  });

  it('a standing rule from the card skips the card next time', async () => {
    const context = await setup();
    await context.send({ text: BOOKING, ref: 'sms:one' });
    await context.confirmer.requests[0]?.remember?.accept();
    const key = autonomyKey('reservation');
    expect(await context.autonomy.find(key.tool, key.scope)).toBeDefined();

    await context.send({ text: '[예시안과] 12월 9일 오전 11시 예약 확정', ref: 'sms:two' });
    expect(context.confirmer.requests).toHaveLength(1);
    expect(context.calls.map((call) => call.input.title)).toEqual(['예시치과 예약', '예시안과 예약']);
  });

  it('asks the masked cheap model only when the rules are unsure, and checks its quote', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({ kind: 'reservation', org: '예시정비소', date: { kind: 'weekday', weekday: 'tue', week: 'next' }, time: { hour: 10, minute: 0, meridiem: 'am' }, evidence: '다음 주 화요일 오전 10시' }),
    ]);
    const context = await setup({ llm });
    const text = '[예시정비소] 차량 점검 예약은 다음 주 화요일 오전 10시예요. 문의 010-1234-5678';
    await context.send({ text });
    const request = llm.requests[0]!;
    expect(request).toMatchObject({ tier: 'fast', sensitivity: 'masked', purpose: 'sms.read' });
    expect(request.messages[1]?.content).toContain('<data kind="sms">');
    expect(request.messages[1]?.content).toContain('[phone]');
    expect(request.messages[1]?.content).not.toContain('010-1234-5678');
    expect(context.calls[0]).toMatchObject({ name: 'calendar.add_event', input: { title: '예시정비소 예약', evidence: '다음 주 화요일 오전 10시' } });

    // sure messages never reach the model
    await context.send({ text: BILL });
    expect(llm.requests).toHaveLength(1);
  });

  it('rules-only mode makes no model call', async () => {
    const llm = new ScriptedLlm();
    const context = await setup({ llm, config: { model: false } });
    await context.send({ text: '예약 관련해서 연락드립니다' });
    expect(llm.requests).toHaveLength(0);
  });

  it('uses the English texts for an English owner', async () => {
    const context = await setup({ language: 'en' });
    await context.send({ text: BOOKING });
    expect(context.confirmer.requests[0]?.summary).toBe("Add '예시치과 booking' to your calendar?");
  });

  it('topics stay valid for any ref', () => {
    expect(topicFor('bill', 'sms:a b/c?')).toBe('sms:bill:abc');
    expect(topicFor('parcel', '')).toBe('sms:parcel:unknown');
  });
});

describe('sms-reader smishing warnings', () => {
  it('warns with the reasons, shows the host defanged, and extracts nothing', async () => {
    const llm = new ScriptedLlm();
    const context = await setup({ llm });
    await context.send({ text: SMISHING, from: '010-1234-5678', ref: 'sms:bad' });
    const notice = context.notifier.notices[0]!;
    expect(notice.kind).toBe('phone.smishing');
    expect(notice.dedupeKey).toBe('sms:bad');
    expect(notice.text.startsWith('⚠️ 스미싱 의심 문자예요 (보낸 곳: 010-1234-5678).')).toBe(true);
    expect(notice.text).toContain('주소를 흉내 낸 링크');
    expect(notice.text).toContain('cj-logis[.]top');
    expect(notice.text).not.toContain('http://cj-logis.top');
    expect(context.confirmer.requests).toHaveLength(0);
    expect(context.calls).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('a smishing message that reads like a reservation still gets no card', async () => {
    const context = await setup();
    await context.send({ text: '[예시호텔] 12월 3일 예약 확정. 결제 실패로 즉시 확인 https://bit.ly/abc123', from: '+8613012345678' });
    expect(context.notifier.notices[0]?.kind).toBe('phone.smishing');
    expect(context.confirmer.requests).toHaveLength(0);
  });

  it('claims smishing and sure notices for the bridge, by rules only', async () => {
    const context = await setup();
    const claims = context.provided.get(Contracts.smsReader.id) as SmsReaderClaims;
    expect(claims.claim({ text: SMISHING })).toBe('smishing');
    expect(claims.claim({ text: BILL })).toBe('notice');
    expect(claims.claim({ text: '예약 관련해서 연락드립니다' })).toBeUndefined();
    expect(claims.claim({ text: '[예시카드] 승인 12,000원 일시불 예시카페' })).toBeUndefined();
  });
});
