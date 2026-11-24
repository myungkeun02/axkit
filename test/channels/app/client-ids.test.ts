import { describe, expect, it } from 'vitest';
import { ClientIds } from '../../../src/channels/app/client-ids.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const DAY_MS = 86_400_000;

describe('app message clientId', () => {
  it('makes one message when two copies arrive together', async () => {
    const ids = new ClientIds(new MapKeyValueStore(), () => new Date(0));
    let made = 0;
    const create = async (): Promise<number> => {
      made += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 7;
    };
    const [first, second] = await Promise.all([ids.once('c1', create), ids.once('c1', create)]);
    expect(made).toBe(1);
    expect(first).toEqual({ seq: 7, duplicate: false });
    expect(second).toEqual({ seq: 7, duplicate: true });
  });

  it('still knows the id after a restart, for a day', async () => {
    const kv = new MapKeyValueStore();
    let now = 0;
    await new ClientIds(kv, () => new Date(now)).once('c1', async () => 3);
    const restarted = new ClientIds(kv, () => new Date(now));
    expect(await restarted.once('c1', async () => 4)).toEqual({ seq: 3, duplicate: true });
    now = 2 * DAY_MS;
    expect(await new ClientIds(kv, () => new Date(now)).once('c1', async () => 5)).toEqual({ seq: 5, duplicate: false });
  });

  it('lets a resend through when the first copy failed', async () => {
    const ids = new ClientIds(new MapKeyValueStore(), () => new Date(0));
    await expect(ids.once('c1', async () => Promise.reject(new Error('log full')))).rejects.toThrow('log full');
    expect(await ids.once('c1', async () => 9)).toEqual({ seq: 9, duplicate: false });
  });
});
