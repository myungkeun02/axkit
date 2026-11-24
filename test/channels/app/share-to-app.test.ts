import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppFiles, looksLike } from '../../../src/channels/app/files.js';
import { filesSkill } from '../../../src/skills/files/plugin.js';
import { FakeClock } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';
import { api, events, pairApp, startApp } from './harness.js';

const PDF = Buffer.from('%PDF-1.7\nfake pdf body\n%%EOF');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ownerHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'axkit-owner-')));
  dirs.push(home);
  await mkdir(join(home, 'Documents'), { recursive: true });
  await mkdir(join(home, 'Library'), { recursive: true });
  await writeFile(join(home, 'Documents', '계약서.pdf'), PDF);
  await writeFile(join(home, 'Documents', 'fake.pdf'), 'MZ this is a program');
  await writeFile(join(home, 'Documents', 'tool.exe'), 'MZ');
  await writeFile(join(home, 'Documents', 'bank-statement.pdf'), PDF);
  await writeFile(join(home, 'Library', 'a.pdf'), PDF);
  return home;
}

describe('files.share_to_app', () => {
  it('posts the file in the app chat as an attachment the phone can download', async () => {
    const home = await ownerHome();
    const h = await startApp({ plugins: [filesSkill({ home })] });
    try {
      const { token } = await pairApp(h);
      const outcome = await h.app.executor.execute('files.share_to_app', { path: '~/Documents/계약서.pdf' });
      expect(outcome).toMatchObject({
        status: 'done',
        output: { name: '계약서.pdf', size: PDF.length, contentType: 'application/pdf' },
      });

      const message = (await events(h, token)).find((event) => event.type === 'message');
      expect(message).toMatchObject({ role: 'assistant', text: '요청한 파일이에요: 계약서.pdf' });
      const attachment = message?.type === 'message' ? message.attachments?.[0] : undefined;
      expect(attachment).toMatchObject({
        name: '계약서.pdf',
        contentType: 'application/pdf',
        size: PDF.length,
        url: expect.stringMatching(/^files\/doc_[0-9a-f]{24}\.pdf$/),
      });
      const download = await api(h, token, attachment?.url ?? '');
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('application/pdf');
      expect(Buffer.from(await download.arrayBuffer()).equals(PDF)).toBe(true);

      for (const [path, error] of [
        ['~/Documents/fake.pdf', '파일 이름과 실제 내용이 달라서 보내지 않았어요. 이름만 바꾼 다른 파일일 수 있어요.'],
        ['~/Documents/tool.exe', '이 종류의 파일은 다룰 수 없어요.'],
        ['~/Documents/bank-statement.pdf', '이 파일은 비밀번호·키·개인 서류일 수 있어서 열지 않아요.'],
        ['~/Library/a.pdf', '이 파일은 비밀번호·키·개인 서류일 수 있어서 열지 않아요.'],
        ['/etc/hosts', '홈 폴더 안의 파일만 열 수 있어요.'],
      ] as const) {
        expect(await h.app.executor.execute('files.share_to_app', { path })).toEqual({ status: 'failed', error });
      }
    } finally {
      await h.stop();
    }
  });

  it('refuses with a plain reason when the app channel is not loaded', async () => {
    const home = await ownerHome();
    const { ctx } = createTestContext();
    await filesSkill({ home }).setup(ctx);
    const outcome = await ctx.tools.execute('files.share_to_app', { path: '~/Documents/계약서.pdf' });
    expect(outcome).toEqual({
      status: 'failed',
      error: '폰 앱이 연결돼 있지 않아서 파일을 보낼 수 없어요. 맥에서 ax-kit setup으로 앱을 연결해 주세요.',
    });
  });
});

describe('AppFiles.addDocument', () => {
  it('checks the bytes against the type, caps the size and serves documents by id', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'axkit-docs-')));
    dirs.push(dir);
    const files = new AppFiles(join(dir, 'app'), new FakeClock());
    await writeFile(join(dir, 'a.docx'), DOCX);
    await writeFile(join(dir, 'big.zip'), Buffer.alloc(20 * 1024 * 1024 + 1));
    await writeFile(join(dir, 'empty.txt'), '');

    const added = await files.addDocument({ path: join(dir, 'a.docx') });
    expect(added.id).toMatch(/^doc_[0-9a-f]{24}\.docx$/);
    expect((await files.read(added.id))?.contentType).toContain('wordprocessingml');
    await expect(files.addDocument({ path: join(dir, 'big.zip') })).rejects.toThrow('larger than 20 MB');
    await expect(files.addDocument({ path: join(dir, 'empty.txt') })).rejects.toThrow('empty');
    // an image id is still served only as an image
    expect(await files.read('img_1.pdf')).toBeUndefined();

    expect(looksLike('txt', Buffer.from('plain 글자'))).toBe(true);
    expect(looksLike('md', Buffer.from([0x61, 0x00]))).toBe(false);
    expect(looksLike('xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe(true);
    expect(looksLike('jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(looksLike('png', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(looksLike('exe', Buffer.from('MZ'))).toBe(false);
  });
});
