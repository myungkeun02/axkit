import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceApi, DeviceApiResponse, DeviceUpload } from '../../../src/core/contracts/device-api.js';
import { RecordingStore } from '../../../src/skills/recordings/store.js';
import { assembleRecording, registerRecordingUpload } from '../../../src/skills/recordings/upload.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';

type Handler = (upload: DeviceUpload) => Promise<DeviceApiResponse>;

async function setup() {
  const dir = join(await mkdtemp(join(tmpdir(), 'axkit-asm-')), 'recordings');
  const store = new RecordingStore(new MapKeyValueStore(), dir);
  const clock = new FakeClock(new Date('2026-11-23T00:00:00Z'));
  const completed: string[] = [];
  let handler: Handler | undefined;
  const api = { upload: (_path: string, fn: Handler) => void (handler = fn) } as unknown as DeviceApi;
  registerRecordingUpload({ api, store, clock, onComplete: (id) => void completed.push(id) });
  const send = async (id: string, index: number, total: number, body: string) => {
    const response = await handler!({
      params: { id, index: String(index) },
      headers: { 'x-chunk-total': String(total) },
      contentType: 'audio/mp4',
      bytes: Buffer.from(body),
    } as unknown as DeviceUpload);
    return response.body as { received: number; complete: boolean };
  };
  return { store, clock, completed, send, dir };
}

describe('recording assembly', () => {
  it('assembles once, publishes the whole file, then moves to transcribing', async () => {
    const s = await setup();
    expect(await s.send('r_a', 0, 2, 'AA')).toMatchObject({ received: 1, complete: false });
    const [one, two] = await Promise.all([s.send('r_a', 1, 2, 'BB'), s.send('r_a', 1, 2, 'BB')]);
    expect([one?.complete, two?.complete].filter(Boolean)).toHaveLength(1);
    expect(s.completed).toEqual(['r_a']);
    expect((await s.store.get('r_a'))?.status).toBe('transcribing');
    expect(await readFile(s.store.audioPath('r_a'), 'utf8')).toBe('AABB');
    expect((await readdir(s.store.folder('r_a'))).sort()).toEqual(['audio.m4a']);
    expect(await s.send('r_a', 1, 2, 'BB')).toMatchObject({ complete: true });
  });

  it('a failed assembly is not reported complete; the retry assembles again', async () => {
    const s = await setup();
    const assemble = s.store.assemble.bind(s.store);
    let failing = true;
    s.store.assemble = async (...args) => {
      if (failing) throw new Error('disk full');
      return await assemble(...args);
    };
    expect(await s.send('r_b', 0, 1, 'AA')).toEqual({ ok: true, received: 0, complete: false });
    expect((await s.store.get('r_b'))?.status).toBe('receiving');
    expect(s.completed).toEqual([]);
    failing = false;
    expect(await s.send('r_b', 0, 1, 'AA')).toMatchObject({ complete: true });
    expect(s.completed).toEqual(['r_b']);
  });

  it('a restart in the middle of assembling finishes it, also when the file was already published', async () => {
    const s = await setup();
    await s.store.put({ id: 'r_c', startedAt: '', durationSec: 0, total: 1, status: 'assembling', updatedAt: '' });
    await s.store.saveChunk('r_c', 0, Buffer.from('CC'));
    const deps = { store: s.store, clock: s.clock, onComplete: (id: string) => void s.completed.push(id) };
    expect(await assembleRecording(deps, 'r_c', true)).toBe(s.store.audioPath('r_c'));
    // the crash came after the rename: chunks are gone, the published audio stands
    await s.store.update('r_c', { status: 'assembling' }, s.clock.now());
    expect(await assembleRecording(deps, 'r_c', true)).toBe(s.store.audioPath('r_c'));
    expect(s.completed).toEqual(['r_c', 'r_c']);
    expect((await s.store.get('r_c'))?.status).toBe('transcribing');
  });

  it('serializes list writes so recordings created together are all kept', async () => {
    const s = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, index) => s.send(`r_p${index}`, 0, 2, 'x')));
    expect((await s.store.list()).map((item) => item.id).sort()).toHaveLength(10);
  });
});
