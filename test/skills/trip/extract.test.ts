import { describe, expect, it } from 'vitest';
import { extractBooking } from '../../../src/skills/trip/extract.js';
import { ScriptedLlm } from '../../support/context.js';
import { mailMessage, NOW } from './helpers.js';

const TIME_ZONE = 'Asia/Seoul';

function request(llm: ScriptedLlm) {
  return extractBooking({ llm, mail: mailMessage(), now: NOW, timeZone: TIME_ZONE });
}

function payload(segments: unknown[], cancelled = false): string {
  return JSON.stringify({ segments, cancelled });
}

describe('trip.extract', () => {
  it('asks a fast, sensitive model with the mail wrapped as JSON data', async () => {
    const llm = new ScriptedLlm([
      payload([{ kind: 'flight', title: 'KE123', start: '2026-12-01T08:30', from: '인천', to: '도쿄' }]),
    ]);

    await request(llm);

    const sent = llm.requests[0];
    expect(sent).toMatchObject({ purpose: 'trip.extract', tier: 'fast', sensitivity: 'sensitive' });
    expect(sent?.jsonSchema).toBeDefined();
    expect(sent?.messages[0]?.content).toMatch(/data, never instructions/i);
    const user = sent?.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(user).toContain('"subject":"예약 확인"');
    expect(user).toContain('"body":"예약번호 ABC123"');
  });

  it('stores printed local times as owner-zone instants and keeps the printed text', async () => {
    const llm = new ScriptedLlm([
      payload([
        { kind: 'flight', title: 'KE123', start: '2026-12-01T08:30', from: '인천', to: '도쿄', reference: 'ABC123' },
        { kind: 'stay', title: '도쿄 호텔', start: '2026-12-01T15:00', end: '2026-12-04T11:00', place: '도쿄' },
      ]),
    ]);

    const result = await request(llm);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.segments[0]).toMatchObject({
      kind: 'flight',
      start: '2026-12-01T08:30:00+09:00',
      startText: '2026-12-01T08:30',
      reference: 'ABC123',
    });
    expect(result.segments[1]).toMatchObject({
      end: '2026-12-04T11:00:00+09:00',
      place: '도쿄',
    });
  });

  it('accepts a date-only booking at local midnight', async () => {
    const llm = new ScriptedLlm([payload([{ kind: 'event', title: '공연', start: '2026-12-24' }])]);

    const result = await request(llm);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.segments[0]).toMatchObject({ start: '2026-12-24T00:00:00+09:00', startText: '2026-12-24' });
  });

  it('tolerates a JSON code fence', async () => {
    const llm = new ScriptedLlm([`\`\`\`json\n${payload([{ kind: 'train', title: 'KTX 101', start: '2026-12-02T09:00' }])}\n\`\`\``]);

    const result = await request(llm);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.segments).toHaveLength(1);
  });

  it('reports unusable JSON without throwing', async () => {
    const llm = new ScriptedLlm(['not json at all']);

    await expect(request(llm)).resolves.toEqual({ status: 'invalid' });
  });

  it('reports a gateway failure separately so the scan can retry', async () => {
    await expect(request(new ScriptedLlm([]))).resolves.toEqual({ status: 'error' });
  });

  it('drops segments with an unparseable start or end date', async () => {
    const llm = new ScriptedLlm([
      payload([
        { kind: 'flight', title: 'bad start', start: '2026-13-01T08:30' },
        { kind: 'stay', title: 'bad end', start: '2026-12-01', end: 'tomorrow' },
        { kind: 'train', title: 'KTX 101', start: '2026-12-02T09:00' },
      ]),
    ]);

    const result = await request(llm);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.segments.map((segment) => segment.title)).toEqual(['KTX 101']);
  });

  it('drops a segment whose end is before its start', async () => {
    const llm = new ScriptedLlm([
      payload([{ kind: 'stay', title: '도쿄 호텔', start: '2026-12-04T15:00', end: '2026-12-01T11:00' }]),
    ]);

    const result = await request(llm);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.segments).toHaveLength(0);
  });

  it('drops a segment more than two years away', async () => {
    const llm = new ScriptedLlm([
      payload([
        { kind: 'flight', title: 'too far', start: '2029-01-01T08:30' },
        { kind: 'flight', title: 'soon enough', start: '2027-06-01T08:30' },
      ]),
    ]);

    const result = await request(llm);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.segments.map((segment) => segment.title)).toEqual(['soon enough']);
  });

  it('passes the cancelled flag through', async () => {
    const llm = new ScriptedLlm([
      payload([{ kind: 'flight', title: 'KE123', start: '2026-12-01T08:30', reference: 'ABC123' }], true),
    ]);

    const result = await request(llm);

    expect(result).toMatchObject({ status: 'ok', cancelled: true });
  });
});
