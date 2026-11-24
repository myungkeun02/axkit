import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { receiptsSkill } from '../../../src/skills/receipts/plugin.js';
import { receiptsTexts } from '../../../src/skills/receipts/locale.js';
import { scanOnce } from '../../../src/skills/receipts/scan.js';
import { loadMonth, loadSeen } from '../../../src/skills/receipts/store.js';
import { Vault } from '../../../src/skills/receipts/vault.js';
import { createTestContext } from '../../support/context.js';
import {
  attachment,
  captureLogger,
  FakeMailAttachments,
  FakeMailReader,
  FakeOcr,
  FakeVaultFs,
  message,
  NOW,
  summary,
} from './helpers.js';

const MB = 1024 * 1024;

async function setup(options: {
  capabilities?: Record<string, unknown>;
  vaultDir?: string;
  fs?: FakeVaultFs;
} = {}) {
  const fs = options.fs ?? new FakeVaultFs();
  const context = createTestContext({ now: NOW, capabilities: options.capabilities ?? {} });
  await receiptsSkill({
    ...(options.vaultDir !== undefined ? { vaultDir: options.vaultDir } : {}),
    fs,
  }).setup(context.ctx);
  return { ...context, fs };
}

describe('receipts.scan', () => {
  it('registers an hourly job and widens only the first lookback', async () => {
    const mail = new FakeMailReader([summary()], { 'mail-1': message() });
    const { scheduler } = await setup({ capabilities: { [Contracts.mailRead.id]: mail } });

    expect(scheduler.jobs.get('receipts.scan')?.schedule).toEqual({ kind: 'every', seconds: 3_600 });

    await scheduler.run('receipts.scan', NOW);
    expect(mail.queries[0]).toMatchObject({ sinceHours: 2_160, limit: 30 });
    expect(mail.queries[0]?.text).toContain('영수증');
    expect(mail.queries[0]?.text).toContain('invoice');

    await scheduler.run('receipts.scan', NOW);
    expect(mail.queries[1]?.sinceHours).toBe(72);
    expect(mail.readIds).toEqual(['mail-1']);
  });

  it('copies the mail and its attachments into the vault and indexes them', async () => {
    const fs = new FakeVaultFs();
    const mail = new FakeMailReader([summary()], { 'mail-1': message() });
    const attachments = new FakeMailAttachments([attachment()], { 'att-1': new Uint8Array([1, 2, 3]) });
    const { ctx, scheduler } = await setup({
      vaultDir: '/vault',
      fs,
      capabilities: { [Contracts.mailRead.id]: mail, [Contracts.mailAttachments.id]: attachments },
    });

    await scheduler.run('receipts.scan', NOW);

    const entries = await loadMonth(ctx.kv, '2026-11');
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      id: 'mail-1',
      mailId: 'mail-1',
      kind: 'receipt',
      amount: 12_345,
      currency: 'KRW',
      merchant: '카페 예시',
      merchantKey: '카페예시',
      subject: '영수증 안내',
    });
    expect(entry.files).toHaveLength(2);
    expect(entry.files[0]).toMatch(/^2026-11\/2026-11-17-receipt-.*\/mail\.txt$/);

    const mailFile = String(fs.files.get(path.join('/vault', entry.files[0]!)));
    expect(mailFile).toContain('From: 카페 예시 <billing@example.com>');
    expect(mailFile).toContain('Date: 2026-11-17T01:00:00.000Z');
    expect(mailFile).toContain('Subject: 영수증 안내');
    expect(mailFile).toContain('합계 12,345원');

    expect(fs.calls.filter((call) => call.op === 'writeFile').every((call) => call.mode === 0o600)).toBe(true);
    expect(fs.calls.filter((call) => call.op === 'mkdir').every((call) => call.mode === 0o700)).toBe(true);
    expect(attachments.downloadCalls).toEqual([
      { messageId: 'mail-1', attachmentId: 'att-1', maxBytes: 10 * MB },
    ]);
  });

  it('saves at most five allowed attachments and counts the rest as skipped', async () => {
    const fs = new FakeVaultFs();
    const listed = [
      attachment({ id: 'a1', filename: 'one.pdf', size: 100 }),
      attachment({ id: 'a2', filename: 'bad.exe', size: 100 }),
      attachment({ id: 'a3', filename: 'big.pdf', size: 11 * MB }),
      ...['a4', 'a5', 'a6', 'a7', 'a8'].map((id) =>
        attachment({ id, filename: `${id}.png`, mimeType: 'image/png', size: 10 }),
      ),
    ];
    const data = Object.fromEntries(
      ['a1', 'a4', 'a5', 'a6', 'a7'].map((id) => [id, new Uint8Array([1])]),
    );
    const mail = new FakeMailReader([summary()], { 'mail-1': message() });
    const attachments = new FakeMailAttachments(listed, data);
    const { ctx } = await setup({
      vaultDir: '/vault',
      fs,
      capabilities: { [Contracts.mailRead.id]: mail, [Contracts.mailAttachments.id]: attachments },
    });
    const vault = new Vault({ vaultDir: '/vault', fs });

    const result = await scanOnce(ctx, { vault, texts: receiptsTexts('ko') }, NOW);

    expect(result).toEqual({ saved: 1, skippedAttachments: 3 });
    expect(attachments.downloadCalls.map((call) => call.attachmentId)).toEqual(['a1', 'a4', 'a5', 'a6', 'a7']);
    const entries = await loadMonth(ctx.kv, '2026-11');
    expect(entries[0]?.files).toHaveLength(6);
  });

  it('marks read ids as seen and does not read them again', async () => {
    const mail = new FakeMailReader(
      [summary(), summary({ id: 'mail-2', subject: '안녕하세요', from: '민수 <minsu@example.com>' })],
      {
        'mail-1': message(),
        'mail-2': message({
          id: 'mail-2',
          threadId: 'thread-2',
          subject: '안녕하세요',
          from: '민수 <minsu@example.com>',
          body: '내일 봬요.',
        }),
      },
    );
    const { ctx, scheduler } = await setup({ capabilities: { [Contracts.mailRead.id]: mail } });

    await scheduler.run('receipts.scan', NOW);
    await scheduler.run('receipts.scan', NOW);

    expect(mail.readIds).toEqual(['mail-1', 'mail-2']);
    expect(await loadSeen(ctx.kv)).toEqual(['mail-1', 'mail-2']);
    expect(await loadMonth(ctx.kv, '2026-11')).toHaveLength(1);
  });

  it('skips ids that were seen before this run', async () => {
    const mail = new FakeMailReader([summary()], { 'mail-1': message() });
    const { ctx, scheduler } = await setup({ capabilities: { [Contracts.mailRead.id]: mail } });
    await ctx.kv.set('seen', ['mail-1']);

    await scheduler.run('receipts.scan', NOW);
    expect(mail.readIds).toEqual([]);
  });

  it('keeps an index without a vault root and never fetches attachments', async () => {
    const fs = new FakeVaultFs();
    const mail = new FakeMailReader([summary()], { 'mail-1': message() });
    const attachments = new FakeMailAttachments([attachment()], { 'att-1': new Uint8Array([1]) });
    const { ctx, scheduler } = await setup({
      fs,
      capabilities: { [Contracts.mailRead.id]: mail, [Contracts.mailAttachments.id]: attachments },
    });

    await scheduler.run('receipts.scan', NOW);

    const entries = await loadMonth(ctx.kv, '2026-11');
    expect(entries[0]?.files).toEqual([]);
    expect(attachments.listCalls).toEqual([]);
    expect(fs.calls).toEqual([]);
  });

  it('keeps going when one mail cannot be read', async () => {
    const mail = new FakeMailReader([summary({ id: 'missing' })]);
    const { ctx, scheduler } = await setup({ capabilities: { [Contracts.mailRead.id]: mail } });

    await expect(scheduler.run('receipts.scan', NOW)).resolves.toBeUndefined();
    expect(await loadSeen(ctx.kv)).toEqual([]);
    expect(await loadMonth(ctx.kv, '2026-11')).toEqual([]);
  });

  it('fills a missing amount and merchant from the first saved PDF with OCR', async () => {
    const fs = new FakeVaultFs();
    const mail = new FakeMailReader([summary()], {
      'mail-1': message({ from: 'billing@example.com', body: '결제가 완료되었습니다.' }),
    });
    const attachments = new FakeMailAttachments([attachment({ filename: 'receipt.pdf' })], {
      'att-1': new Uint8Array([1]),
    });
    const ocr = new FakeOcr({
      text: '가맹점: 예시커피 강남점\n2026-11-1514:32\n합계 12,500원',
      pages: 1,
      method: 'vision',
    });
    const { ctx, scheduler } = await setup({
      vaultDir: '/vault',
      fs,
      capabilities: {
        [Contracts.mailRead.id]: mail,
        [Contracts.mailAttachments.id]: attachments,
        [Contracts.ocr.id]: ocr,
      },
    });

    await scheduler.run('receipts.scan', NOW);

    const entries = await loadMonth(ctx.kv, '2026-11');
    expect(entries[0]).toMatchObject({
      amount: 12_500,
      currency: 'KRW',
      merchant: '예시커피 강남점',
      merchantKey: '예시커피강남점',
    });
    expect(ocr.paths).toHaveLength(1);
    expect(ocr.paths[0]).toMatch(/^\/vault\/.*\/att-1-receipt\.pdf$/);
  });

  it('keeps indexing when text recognition fails and logs no file text', async () => {
    const fs = new FakeVaultFs();
    const mail = new FakeMailReader([summary()], {
      'mail-1': message({ from: 'billing@example.com', body: '결제가 완료되었습니다.' }),
    });
    const attachments = new FakeMailAttachments([attachment()], { 'att-1': new Uint8Array([1]) });
    const ocr = new FakeOcr(new Error('가맹점: 예시커피 강남점 합계 12,500원'));
    const { ctx, scheduler } = await setup({
      vaultDir: '/vault',
      fs,
      capabilities: {
        [Contracts.mailRead.id]: mail,
        [Contracts.mailAttachments.id]: attachments,
        [Contracts.ocr.id]: ocr,
      },
    });
    const log = captureLogger();
    ctx.log = log;

    await scheduler.run('receipts.scan', NOW);

    const entries = await loadMonth(ctx.kv, '2026-11');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBeUndefined();
    expect(log.warnings.some((warning) => warning.includes('text recognition'))).toBe(true);
    expect(log.warnings.join('\n')).not.toContain('12,500');
  });

  it('does not recognize text when the mail already states the amount', async () => {
    const fs = new FakeVaultFs();
    const mail = new FakeMailReader([summary()], { 'mail-1': message({ from: 'billing@example.com' }) });
    const attachments = new FakeMailAttachments([attachment()], { 'att-1': new Uint8Array([1]) });
    const ocr = new FakeOcr({ text: '합계 99,000원', pages: 1, method: 'vision' });
    const { ctx, scheduler } = await setup({
      vaultDir: '/vault',
      fs,
      capabilities: {
        [Contracts.mailRead.id]: mail,
        [Contracts.mailAttachments.id]: attachments,
        [Contracts.ocr.id]: ocr,
      },
    });

    await scheduler.run('receipts.scan', NOW);

    const entries = await loadMonth(ctx.kv, '2026-11');
    expect(entries[0]?.amount).toBe(12_345);
    expect(ocr.paths).toEqual([]);
  });

  it('caps the indexed subject at 120 characters', async () => {
    const subject = `영수증 ${'가'.repeat(200)}`;
    const mail = new FakeMailReader([summary({ subject })], { 'mail-1': message({ subject }) });
    const { ctx, scheduler } = await setup({ capabilities: { [Contracts.mailRead.id]: mail } });

    await scheduler.run('receipts.scan', NOW);
    const entries = await loadMonth(ctx.kv, '2026-11');
    expect(entries[0]?.subject).toHaveLength(120);
  });
});
