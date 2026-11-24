import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceApi, DeviceApiResponse, DeviceUpload } from '../../../src/core/contracts/device-api.js';
import { isMadeUp, registerDictation } from '../../../src/skills/recordings/dictation.js';
import type { Transcriber } from '../../../src/skills/recordings/transcribe.js';
import { TranscriberMissingError } from '../../../src/skills/recordings/transcribe.js';

type Handler = (upload: DeviceUpload) => Promise<DeviceApiResponse>;

async function setup(transcriber: Transcriber | undefined, loudness?: (path: string) => Promise<number | undefined>) {
  let handler: Handler | undefined;
  const paths: string[] = [];
  const api = { upload: (path: string, fn: Handler) => void (paths.push(path), (handler = fn)) } as unknown as DeviceApi;
  const dir = join(await mkdtemp(join(tmpdir(), 'axk-dict-')), 'd');
  registerDictation({ api, transcriber, dir, korean: true, warn: () => undefined, ...(loudness !== undefined ? { loudness } : {}) });
  const send = (bytes: number, contentType = 'audio/mp4') =>
    (handler as Handler)({ caller: { deviceId: 'd', deviceName: 'mac', platform: 'desktop' }, name: 'clip', contentType, bytes: Buffer.alloc(bytes, 1), params: {}, headers: {} });
  return { send, paths, dir };
}

describe('dictation (the mic button)', () => {
  it('turns a clip into text for the input box and keeps nothing', async () => {
    const seen: string[] = [];
    const { send, paths, dir } = await setup({ transcribe: async (path) => (seen.push(path), '  내일 회의\n 3시로 잡아줘 ') });
    expect(paths).toEqual(['dictation']);
    expect(await send(5000)).toEqual({ status: 200, body: { ok: true, text: '내일 회의 3시로 잡아줘' } });
    expect(seen[0]).toMatch(/\.m4a$/);
    expect(await readdir(dir)).toEqual([]);
    expect((await send(5000, 'audio/webm;codecs=opus')).status).toBe(200);
    expect(seen[1]).toMatch(/\.webm$/);
  });

  it('says plainly when it cannot: too short, too long, no speech, no transcriber', async () => {
    const quiet = await setup({ transcribe: async () => '[BLANK_AUDIO]' });
    expect((await quiet.send(100)).status).toBe(400);
    expect((await quiet.send(13 * 1024 * 1024)).status).toBe(413);
    expect(await quiet.send(5000)).toMatchObject({ status: 200, body: { text: '' } });
    expect((await (await setup(undefined)).send(5000)).status).toBe(503);
    const silent = await setup({ transcribe: async () => '감사합니다.' }, async () => -70);
    expect(await silent.send(5000)).toMatchObject({ status: 200, body: { text: '', message: expect.stringContaining('마이크 소리가 거의 들어오지 않았어요') } });
    const missing = await setup({ transcribe: async () => { throw new TranscriberMissingError('no model'); } });
    expect(await missing.send(5000)).toMatchObject({ status: 503, body: { error: 'no_transcriber' } });
  });
});

describe('words whisper makes up for noise', () => {
  it('drops a clip that is only a subtitle phrase, keeps real sentences', () => {
    for (const text of ['감사합니다.', ' 감사합니다 ', '시청해 주셔서 감사합니다.', '구독과 좋아요 부탁드립니다', 'MBC 뉴스 김철수입니다.', 'Thank you.', '[BLANK_AUDIO]', '(음악)', '']) expect(isMadeUp(text)).toBe(true);
    for (const text of ['도와줘서 감사합니다 내일 보자', '내일 오후 3시에 회의 잡아줘.', '감사합니다 라고 답장 보내 줘']) expect(isMadeUp(text)).toBe(false);
  });
});
