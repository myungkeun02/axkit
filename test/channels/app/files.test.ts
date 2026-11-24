import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppFiles, sniffImage } from '../../../src/channels/app/files.js';
import { Caps } from '../../../src/core/plugin/types.js';
import { FakeClock } from '../../core/helpers.js';
import { api, events, pairApp, startApp, until } from './harness.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg')]);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'axkit-files-'));
  dirs.push(dir);
  return dir;
}

describe('app files', () => {
  it('copies in only real images and serves them by id', async () => {
    const dir = await tempDir();
    const files = new AppFiles(join(dir, 'app'), new FakeClock());
    await writeFile(join(dir, 'poster.png'), PNG);
    await writeFile(join(dir, 'notes.png'), 'not an image');
    await writeFile(join(dir, 'photo.jpg'), JPEG);

    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPEG)).toBe('jpg');
    expect(await files.addImage({ path: join(dir, 'notes.png') })).toBeUndefined();
    expect(await files.addImage({ path: join(dir, 'missing.png') })).toBeUndefined();

    const added = await files.addImage({ path: join(dir, 'poster.png') });
    expect(added).toMatchObject({ name: 'poster.png', contentType: 'image/png', size: PNG.length });
    expect(added?.url).toBe(`files/${added?.id}`);
    expect(added?.id).toMatch(/^img_[0-9a-f]{24}\.png$/);
    const read = await files.read(added?.id ?? '');
    expect(read?.bytes.equals(PNG)).toBe(true);
    expect(read?.contentType).toBe('image/png');

    for (const bad of ['..', '../poster.png', 'a/b.png', '.', 'x'.repeat(201), 'missing.png', 'img_1.txt']) {
      expect(await files.read(bad)).toBeUndefined();
    }
  });

  it('does not follow a link planted in the folder', async () => {
    const dir = await tempDir();
    const files = new AppFiles(join(dir, 'app'), new FakeClock());
    await writeFile(join(dir, 'a.png'), PNG);
    await files.addImage({ path: join(dir, 'a.png') });
    await writeFile(join(dir, 'secret.png'), PNG);
    await symlink(join(dir, 'secret.png'), join(dir, 'app', 'link.png'));
    expect(await files.read('link.png')).toBeUndefined();
  });

  it('turns message pictures into attachments and one https imageUrl', async () => {
    const dir = await tempDir();
    const files = new AppFiles(join(dir, 'app'), new FakeClock());
    await writeFile(join(dir, 'p.png'), PNG);
    const media = await files.media([
      { url: 'http://insecure.example/a.png' },
      { url: 'https://cdn.example/a.png' },
      { url: 'https://cdn.example/b.png' },
      { path: join(dir, 'p.png'), name: '포스터.png' },
    ]);
    expect(media.imageUrl).toBe('https://cdn.example/a.png');
    expect(media.attachments).toHaveLength(1);
    expect(media.attachments?.[0]?.name).toBe('포스터.png');
  });

  it('prunes month-old files except the pictures of open cards, and the oldest when the folder is too big', async () => {
    const dir = await tempDir();
    const clock = new FakeClock(new Date('2026-11-18T10:00:00Z'));
    const files = new AppFiles(join(dir, 'app'), clock);
    await writeFile(join(dir, 'p.png'), PNG);
    const old = await files.addImage({ path: join(dir, 'p.png') });
    const kept = await files.addImage({ path: join(dir, 'p.png') });
    const fresh = await files.addImage({ path: join(dir, 'p.png') });
    const past = new Date('2026-10-18T09:00:00Z');
    for (const id of [old?.id, kept?.id]) await utimes(join(dir, 'app', id ?? ''), past, past);
    await utimes(join(dir, 'app', fresh?.id ?? ''), new Date('2026-11-18T09:00:00Z'), new Date('2026-11-18T09:00:00Z'));
    expect(await files.prune(new Set([kept?.id ?? '']))).toBe(1);
    expect((await readdir(join(dir, 'app'))).sort()).toEqual([kept?.id, fresh?.id].sort());

    // a week-old file stays by age, but goes first when the folder is over its cap
    const week = await files.addImage({ path: join(dir, 'p.png') });
    const weekAgo = new Date('2026-11-11T10:00:00Z');
    await utimes(join(dir, 'app', week?.id ?? ''), weekAgo, weekAgo);
    expect(await files.prune(new Set([kept?.id ?? '']))).toBe(0);
    expect(await files.prune(new Set([kept?.id ?? '']), PNG.length)).toBe(1);
    expect((await readdir(join(dir, 'app'))).sort()).toEqual([kept?.id, fresh?.id].sort());
  });
});

const posterTool = (path: string) => ({
  name: 'test.post',
  description: 'posts a poster',
  input: z.object({ to: z.string() }),
  effects: ['send' as const],
  describe: (input: { to: string }) => `Post the poster to ${input.to}`,
  images: () => [{ path, name: 'poster.png' }],
  run: async () => 'posted',
});

describe('pictures over the app channel', () => {
  it('serves message and card pictures at files/<id> with the app token only', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'poster.png'), PNG);
    const h = await startApp({
      plugins: [
        {
          manifest: { id: 'skill.test-post', kind: 'skill', title: 'test' },
          setup(ctx) {
            ctx.registerTool(posterTool(join(dir, 'poster.png')));
          },
        },
      ],
    });
    try {
      const { token } = await pairApp(h);
      const replier = h.app.host.capability(Caps.replier)!;
      await replier.reply(
        { channelId: 'channel.app', address: 'owner', replyTo: 'x' },
        { text: '포스터예요', images: [{ path: join(dir, 'poster.png') }, { url: 'https://cdn.example/p.png' }] },
      );
      const message = (await events(h, token)).find((event) => event.type === 'message');
      expect(message).toMatchObject({ text: '포스터예요', imageUrl: 'https://cdn.example/p.png' });
      const attachment = message?.type === 'message' ? message.attachments?.[0] : undefined;
      expect(attachment).toMatchObject({ name: 'poster.png', contentType: 'image/png', url: expect.stringMatching(/^files\//) });

      const download = await api(h, token, attachment?.url ?? '');
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('image/png');
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await download.arrayBuffer()).equals(PNG)).toBe(true);
      expect((await fetch(`${h.base}/m/v1/app/${attachment?.url ?? ''}`)).status).toBe(401);
      expect((await api(h, token, 'files/nope.png')).status).toBe(404);
      expect((await api(h, token, 'files/..%2Fdata%2Fax-kit.db')).status).toBe(404);

      void h.app.executor.execute('test.post', { to: 'X' });
      await until(async () => (await events(h, token)).some((event) => event.type === 'card'));
      const card = (await events(h, token)).find((event) => event.type === 'card');
      expect(card?.type === 'card' ? card.attachments?.[0] : undefined).toMatchObject({ name: 'poster.png', contentType: 'image/png' });
    } finally {
      await h.stop();
    }
  });
});
