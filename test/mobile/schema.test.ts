import { describe, expect, it } from 'vitest';
import { parseIngestBody, parseTimestamp } from '../../src/mobile/schema.js';
import type { IngestParseResult } from '../../src/mobile/schema.js';
import { NOW } from './helpers.js';

const OPTIONS = { now: NOW, timeZone: 'Asia/Seoul' };

function parsed(body: unknown): Extract<IngestParseResult, { ok: true }> {
  const result = parseIngestBody(body, OPTIONS);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

function failure(body: unknown): Extract<IngestParseResult, { ok: false }> {
  const result = parseIngestBody(body, OPTIONS);
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result)}`);
  return result;
}

describe('body shapes', () => {
  it('reads an items envelope', () => {
    const body = {
      v: 1,
      ts: NOW.toISOString(),
      items: [
        { kind: 'location', lat: 37.5665, lng: 126.978 },
        { kind: 'steps', steps: '8123' },
      ],
    };

    const result = parsed(body);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ kind: 'location', lat: 37.5665, lng: 126.978, at: NOW });
    expect(result.items[1]).toMatchObject({ kind: 'steps', steps: 8123, at: NOW });
  });

  it('reads a flat dictionary, trims and lowercases the kind and coerces strings', () => {
    const result = parsed({
      v: '1',
      ts: NOW.toISOString(),
      kind: ' Location ',
      lat: '37,5665',
      lng: '126,978',
      label: 'example',
    });

    expect(result.items[0]).toMatchObject({ kind: 'location', lat: 37.5665, lng: 126.978, label: 'example' });
  });

  it('accepts count as an alias for steps and clips long strings', () => {
    const result = parsed({
      v: 1,
      ts: NOW.toISOString(),
      items: [
        { kind: 'steps', count: 1000 },
        { kind: 'sms', text: '가'.repeat(1500), from: 'a'.repeat(300) },
        { kind: 'voice_memo', text: '나'.repeat(9000) },
        { kind: 'notification', app: 'a'.repeat(300), title: 'b'.repeat(300), text: 'c'.repeat(500) },
      ],
    });

    const [steps, sms, voice, notification] = result.items;
    expect(steps).toMatchObject({ kind: 'steps', steps: 1000 });
    if (sms?.kind !== 'sms' || voice?.kind !== 'voice_memo' || notification?.kind !== 'notification') {
      throw new Error('unexpected items');
    }
    expect(sms.text).toHaveLength(1000);
    expect(sms.from).toHaveLength(200);
    expect(voice.text).toHaveLength(8000);
    expect(notification.app).toHaveLength(200);
    expect(notification.title).toHaveLength(200);
    expect(notification.text).toHaveLength(200);
  });

  it('normalizes battery fractions and percent values', () => {
    const fraction = parsed({ v: 1, ts: NOW.toISOString(), kind: 'battery', level: 0.52 });
    const percent = parsed({ v: 1, ts: NOW.toISOString(), kind: 'battery', level: '87' });
    const full = parsed({ v: 1, ts: NOW.toISOString(), kind: 'battery', level: 1 });

    expect(fraction.items[0]).toMatchObject({ kind: 'battery', level: 52 });
    expect(percent.items[0]).toMatchObject({ kind: 'battery', level: 87 });
    expect(full.items[0]).toMatchObject({ kind: 'battery', level: 100 });
  });

  it('keeps an explicit day on steps and screen time', () => {
    const result = parsed({
      v: 1,
      ts: NOW.toISOString(),
      items: [
        { kind: 'steps', steps: 500, date: '2026-11-16' },
        { kind: 'screen_time', minutes: 95, date: '2026-11-16' },
      ],
    });

    expect(result.items[0]).toMatchObject({ kind: 'steps', date: '2026-11-16' });
    expect(result.items[1]).toMatchObject({ kind: 'screen_time', minutes: 95, date: '2026-11-16' });
  });
});

describe('timestamps', () => {
  it('accepts ISO 8601, epoch seconds and milliseconds, and owner-zone wall time', () => {
    const iso = NOW.toISOString();
    const seconds = Math.floor(NOW.getTime() / 1000);
    const millis = NOW.getTime();

    expect(parseTimestamp(iso, 'Asia/Seoul')?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp(seconds, 'Asia/Seoul')?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp(String(seconds), 'Asia/Seoul')?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp(millis, 'Asia/Seoul')?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp(String(millis), 'Asia/Seoul')?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp('2026-11-17 09:00:00', 'Asia/Seoul')?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp('2026-11-17T09:00:00+09:00', 'Asia/Seoul')?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp('nonsense', 'Asia/Seoul')).toBeUndefined();
    expect(parseTimestamp(undefined, 'Asia/Seoul')).toBeUndefined();
  });

  it('accepts a timestamp up to five minutes old or ahead and refuses more', () => {
    const edge = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(parsed({ v: 1, ts: edge, kind: 'battery', level: 50 }).at.getTime()).toBe(NOW.getTime() - 5 * 60_000);

    expect(failure({ v: 1, ts: new Date(NOW.getTime() - 5 * 60_000 - 1).toISOString(), kind: 'battery', level: 50 })).toEqual({
      ok: false,
      error: 'stale',
    });
    expect(failure({ v: 1, ts: new Date(NOW.getTime() + 5 * 60_000 + 1).toISOString(), kind: 'battery', level: 50 })).toEqual({
      ok: false,
      error: 'stale',
    });
  });
});

describe('queued items', () => {
  it('keeps an item time up to two days old and refuses older ones', () => {
    const hourAgo = new Date(NOW.getTime() - 3_600_000);
    const result = parsed({ v: 1, ts: NOW.toISOString(), items: [{ kind: 'battery', level: 40, at: hourAgo.toISOString() }] });
    expect(result.items[0]?.at.getTime()).toBe(hourAgo.getTime());
    const old = new Date(NOW.getTime() - 49 * 3_600_000).toISOString();
    expect(failure({ v: 1, ts: NOW.toISOString(), items: [{ kind: 'battery', level: 40, at: old }] }).error).toBe('stale');
  });
});

describe('empty and invalid bodies', () => {
  it('reports an empty message text as empty, not as a shape error', () => {
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'sms', text: '   ' })).toEqual({
      ok: false,
      error: 'empty',
      kind: 'sms',
    });
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'notification', app: 'mail', text: ' ' })).toEqual({
      ok: false,
      error: 'empty',
      kind: 'notification',
    });
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'voice_memo', text: '' })).toEqual({
      ok: false,
      error: 'empty',
      kind: 'voice_memo',
    });
  });

  it('refuses bad shapes', () => {
    expect(failure({ v: 2, ts: NOW.toISOString(), kind: 'battery', level: 10 }).error).toBe('shape');
    expect(failure({ v: 1, kind: 'battery', level: 10 }).error).toBe('shape');
    expect(failure({ v: 1, ts: 'nope', kind: 'battery', level: 10 }).error).toBe('shape');
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'unknown' }).error).toBe('shape');
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'location', lat: 100, lng: 0 }).error).toBe('shape');
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'steps' }).error).toBe('shape');
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'screen_time' }).error).toBe('shape');
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'notification', text: 'x' }).error).toBe('shape');
    expect(failure({ v: 1, ts: NOW.toISOString(), kind: 'battery', level: -1 }).error).toBe('shape');
    expect(failure([]).error).toBe('shape');
    expect(failure('body').error).toBe('shape');
    expect(failure({ v: 1, ts: NOW.toISOString(), items: [] }).error).toBe('shape');
    expect(
      failure({
        v: 1,
        ts: NOW.toISOString(),
        items: Array.from({ length: 51 }, () => ({ kind: 'battery', level: 10 })),
      }).error,
    ).toBe('shape');
  });
});
