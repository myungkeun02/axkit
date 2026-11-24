import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ToolOutcome } from '../../../src/core/tools/types.js';
import { receiptsSkill } from '../../../src/skills/receipts/plugin.js';
import type { ReadFileOutput } from '../../../src/skills/receipts/read-file.js';
import { createTestContext } from '../../support/context.js';
import { FakeOcr, FakeSpend, FakeVaultFs, NOW, spendEntry } from './helpers.js';

const VAULT = '/vault';
const DOC = '2026-11/2026-11-15-receipt-영수증 안내-mail-1/receipt.pdf';
const OCR_TEXT = ['가맹점: 예시커피 강남점', '2026-11-1514:32', '합계 12,500원'].join('\n');

async function setup(
  options: { capabilities?: Record<string, unknown>; vaultDir?: string | null; fs?: FakeVaultFs } = {},
) {
  const fs = options.fs ?? new FakeVaultFs();
  const vaultDir = options.vaultDir === undefined ? VAULT : options.vaultDir;
  const context = createTestContext({ now: NOW, capabilities: options.capabilities ?? {} });
  await receiptsSkill({
    ...(vaultDir !== null ? { vaultDir } : {}),
    fs,
  }).setup(context.ctx);
  return { ...context, fs };
}

async function run(
  ctx: ReturnType<typeof createTestContext>['ctx'],
  input: unknown,
): Promise<ToolOutcome> {
  return ctx.tools.execute('receipts.read_file', input);
}

async function done(ctx: ReturnType<typeof createTestContext>['ctx'], input: unknown): Promise<ReadFileOutput> {
  const outcome = await run(ctx, input);
  if (outcome.status !== 'done') throw new Error(`unexpected status: ${outcome.status}`);
  return outcome.output as ReadFileOutput;
}

function vaultWithDoc(): FakeVaultFs {
  return new FakeVaultFs().addFile(`${VAULT}/${DOC}`, new Uint8Array([1, 2, 3]));
}

describe('receipts.read_file', () => {
  it('reads a vault file, parses the receipt and matches the ledger', async () => {
    const fs = vaultWithDoc();
    const ocr = new FakeOcr({ text: OCR_TEXT, pages: 2, method: 'vision' });
    const entry = spendEntry({
      id: 'spend-1',
      at: '2026-11-15T13:00:00+09:00',
      merchant: '예시커피 강남점',
      amount: 12_500,
      originalAmount: 12_500,
    });
    const spend = new FakeSpend([entry], 'KRW');
    const { ctx } = await setup({
      fs,
      capabilities: { [Contracts.ocr.id]: ocr, [Contracts.spendRead.id]: spend },
    });

    const output = await done(ctx, { path: DOC });

    expect(output).toEqual({
      method: 'vision',
      pages: 2,
      text: OCR_TEXT,
      receipt: {
        amount: 12_500,
        currency: 'KRW',
        merchant: '예시커피 강남점',
        date: '2026-11-15',
      },
      matches: [entry],
    });
    expect(ocr.paths).toEqual([`${VAULT}/${DOC}`]);
    expect(spend.ranges).toHaveLength(1);
  });

  it('truncates returned text to 4000 characters', async () => {
    const ocr = new FakeOcr({ text: 'a'.repeat(5_000), pages: 1, method: 'vision' });
    const { ctx } = await setup({ fs: vaultWithDoc(), capabilities: { [Contracts.ocr.id]: ocr } });

    const output = await done(ctx, { path: DOC });

    expect(output.text).toHaveLength(4_000);
    expect(output.matches).toEqual([]);
  });

  it('returns no matches when spending data is unavailable or failing', async () => {
    const ocr = new FakeOcr({ text: OCR_TEXT, pages: 1, method: 'vision' });
    const withoutSpend = await setup({ fs: vaultWithDoc(), capabilities: { [Contracts.ocr.id]: ocr } });
    expect((await done(withoutSpend.ctx, { path: DOC })).matches).toEqual([]);

    const failing = new FakeSpend([], 'KRW', true);
    const withFailing = await setup({
      fs: vaultWithDoc(),
      capabilities: { [Contracts.ocr.id]: ocr, [Contracts.spendRead.id]: failing },
    });
    expect((await done(withFailing.ctx, { path: DOC })).matches).toEqual([]);
  });

  it('refuses a path that climbs out of the vault', async () => {
    const ocr = new FakeOcr({ text: OCR_TEXT, pages: 1, method: 'vision' });
    const { ctx } = await setup({ fs: vaultWithDoc(), capabilities: { [Contracts.ocr.id]: ocr } });

    const outcome = await run(ctx, { path: '../outside.pdf' });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('outside the vault');
    expect(ocr.paths).toEqual([]);
  });

  it('refuses an absolute path outside the vault', async () => {
    const ocr = new FakeOcr({ text: OCR_TEXT, pages: 1, method: 'vision' });
    const { ctx } = await setup({ fs: vaultWithDoc(), capabilities: { [Contracts.ocr.id]: ocr } });

    const outcome = await run(ctx, { path: '/etc/passwd' });

    expect(outcome.status).toBe('failed');
    expect(ocr.paths).toEqual([]);
  });

  it('refuses a symlink that points outside the vault', async () => {
    const fs = vaultWithDoc().addFile('/outside/secret.pdf').addSymlink(`${VAULT}/link.pdf`, '/outside/secret.pdf');
    const ocr = new FakeOcr({ text: OCR_TEXT, pages: 1, method: 'vision' });
    const { ctx } = await setup({ fs, capabilities: { [Contracts.ocr.id]: ocr } });

    const outcome = await run(ctx, { path: 'link.pdf' });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('outside the vault');
    expect(ocr.paths).toEqual([]);
  });

  it('follows a symlink that stays inside the vault', async () => {
    const fs = vaultWithDoc().addSymlink(`${VAULT}/alias.pdf`, `${VAULT}/${DOC}`);
    const ocr = new FakeOcr({ text: OCR_TEXT, pages: 1, method: 'vision' });
    const { ctx } = await setup({ fs, capabilities: { [Contracts.ocr.id]: ocr } });

    await done(ctx, { path: 'alias.pdf' });

    expect(ocr.paths).toEqual([`${VAULT}/${DOC}`]);
  });

  it('explains that recognition is disabled when no recognizer is provided', async () => {
    const { ctx } = await setup({ fs: vaultWithDoc() });

    const outcome = await run(ctx, { path: DOC });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toBe(
      'text recognition is not enabled (connector.macos-ocr)',
    );
  });

  it('refuses when no vault root is configured', async () => {
    const ocr = new FakeOcr({ text: OCR_TEXT, pages: 1, method: 'vision' });
    const { ctx } = await setup({ vaultDir: null, capabilities: { [Contracts.ocr.id]: ocr } });

    const outcome = await run(ctx, { path: DOC });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('vault root is not configured');
  });

  it('rejects an empty path before running', async () => {
    const { ctx } = await setup({ fs: vaultWithDoc() });
    const outcome = await run(ctx, { path: '' });
    expect(outcome.status).toBe('invalid_input');
  });
});
