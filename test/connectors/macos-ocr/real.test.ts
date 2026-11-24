import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { macosOcrConnector } from '../../../src/connectors/macos-ocr/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';

describe.skipIf(process.env.AX_KIT_REAL_OCR !== '1')('VisionTextRecognizer with the real helper', () => {
  it('recognizes text from AX_KIT_OCR_IMAGE', async () => {
    const image = process.env.AX_KIT_OCR_IMAGE;
    if (image === undefined || image === '') throw new Error('AX_KIT_OCR_IMAGE is required');

    const binDir = join(tmpdir(), `ax-kit-ocr-${randomUUID()}`);
    try {
      const { ctx } = createTestContext();
      await macosOcrConnector({ binDir }).setup(ctx);

      const result = await ctx.use(Contracts.ocr).recognize(image);

      expect(result.text.trim().length).toBeGreaterThan(0);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 180_000);
});
