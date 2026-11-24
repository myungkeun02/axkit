import { describe, expect, it } from 'vitest';
import type { PreviewRow } from '../../../src/connectors/screen-chat/tracker.js';
import { PreviewTracker } from '../../../src/connectors/screen-chat/tracker.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { NOW } from './helpers.js';

interface SeenEntry {
  hash: string;
  unread: number | null;
}

async function stored(kv: MapKeyValueStore): Promise<Record<string, SeenEntry>> {
  return (await kv.get<Record<string, SeenEntry>>('seen')) ?? {};
}

function setup(app: 'kakao' | 'discord' = 'kakao'): {
  kv: MapKeyValueStore;
  tracker: PreviewTracker;
} {
  const kv = new MapKeyValueStore();
  return { kv, tracker: new PreviewTracker(kv, app) };
}

const MESSAGE: PreviewRow = { room: '민수', text: '안녕하세요', unread: null };

describe('PreviewTracker', () => {
  it('only seeds the first poll', async () => {
    const { kv, tracker } = setup();

    expect(await tracker.diff([MESSAGE], NOW)).toEqual([]);
    const seen = await stored(kv);
    expect(seen['민수']?.hash).toMatch(/^[0-9a-f]{24}$/);
    expect(seen['민수']?.unread).toBeNull();
  });

  it('emits a preview when the text changes', async () => {
    const { tracker } = setup();
    await tracker.diff([MESSAGE], NOW);

    const previews = await tracker.diff([{ ...MESSAGE, text: '새 메시지' }], NOW);

    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      app: 'kakao',
      room: '민수',
      text: '새 메시지',
      unread: null,
      at: NOW,
    });
    expect(previews[0]?.ref).toMatch(/^[0-9a-f]{24}$/);
  });

  it('does not emit for an unchanged row', async () => {
    const { tracker } = setup();
    await tracker.diff([{ ...MESSAGE, unread: 2 }], NOW);
    expect(await tracker.diff([{ ...MESSAGE, unread: 2 }], NOW)).toEqual([]);
  });

  it('emits an unread-to-read change with unread 0', async () => {
    const { tracker } = setup();
    await tracker.diff([{ ...MESSAGE, unread: 2 }], NOW);

    const previews = await tracker.diff([{ ...MESSAGE, unread: 0 }], NOW);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.unread).toBe(0);
  });

  it('does not emit a read room whose preview changed', async () => {
    const { tracker } = setup();
    await tracker.diff([{ ...MESSAGE, text: '이전', unread: 0 }], NOW);
    expect(await tracker.diff([{ ...MESSAGE, text: '지금', unread: 0 }], NOW)).toEqual([]);
  });

  it('emits empty text only when the room has unread messages', async () => {
    const { tracker } = setup('discord');
    await tracker.diff([], NOW);

    expect(await tracker.diff([{ room: '민수', text: '', unread: null }], NOW)).toEqual([]);
    expect(await tracker.diff([{ room: '민수', text: '', unread: 0 }], NOW)).toEqual([]);
    const previews = await tracker.diff([{ room: '영희', text: '', unread: 1, direct: true }], NOW);
    expect(previews).toEqual([
      expect.objectContaining({ room: '영희', text: '', unread: 1, direct: true }),
    ]);
  });

  it('carries direct only when the row says so', async () => {
    const { tracker } = setup('discord');
    await tracker.diff([MESSAGE], NOW);

    const [withDirect] = await tracker.diff([{ ...MESSAGE, text: 'one', direct: false }], NOW);
    expect(withDirect?.direct).toBe(false);

    const [withoutDirect] = await tracker.diff([{ ...MESSAGE, text: 'two' }], NOW);
    expect(withoutDirect !== undefined && 'direct' in withoutDirect).toBe(false);
  });

  it('keeps rooms that disappeared from the list', async () => {
    const { kv, tracker } = setup();
    await tracker.diff([MESSAGE, { room: '영희', text: '내일 봐요', unread: null }], NOW);

    await tracker.diff([{ ...MESSAGE, text: '새 메시지' }], NOW);

    const seen = await stored(kv);
    expect(Object.keys(seen).sort()).toEqual(['민수', '영희']);
  });

  it('caps the stored map at 300 rooms, dropping the oldest', async () => {
    const { kv, tracker } = setup();
    const rows: PreviewRow[] = Array.from({ length: 300 }, (_, index) => ({
      room: `room${index}`,
      text: 'same',
      unread: 1,
    }));
    await tracker.diff(rows, NOW);
    expect(Object.keys(await stored(kv))).toHaveLength(300);

    const previews = await tracker.diff([{ room: 'room300', text: 'new', unread: 1 }], NOW);

    expect(previews).toHaveLength(1);
    const seen = await stored(kv);
    expect(Object.keys(seen)).toHaveLength(300);
    expect(seen).not.toHaveProperty('room0');
    expect(seen).toHaveProperty('room300');
  });

  it('builds a stable ref from app, room, text and unread state', async () => {
    const first = setup('kakao');
    await first.tracker.diff([MESSAGE], NOW);
    const [one] = await first.tracker.diff([{ ...MESSAGE, text: 'same' }], NOW);

    const second = setup('discord');
    await second.tracker.diff([MESSAGE], NOW);
    const [two] = await second.tracker.diff([{ ...MESSAGE, text: 'same' }], NOW);

    expect(one?.ref).not.toBe(two?.ref);
  });
});
