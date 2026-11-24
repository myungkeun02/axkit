import type { TextRecognizer } from '../../core/contracts/ocr.js';
import { extensionOf } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import { merchantKeyOf } from './classify.js';
import { receiptFromText } from './ocr-parse.js';
import type { Vault } from './vault.js';

const READABLE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'gif', 'bmp', 'webp']);

export interface FilledReceipt {
  amount?: number;
  currency?: string;
  merchant?: string;
  merchantKey?: string;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

/**
 * Text-recognizes the first saved PDF or image and returns whatever amount, currency and merchant it shows.
 * A recognition failure only warns: the document is still indexed.
 */
export async function fillFromFiles(
  recognizer: TextRecognizer,
  vault: Vault,
  files: readonly string[],
  log: Logger,
): Promise<FilledReceipt> {
  try {
    const relative = files.find((file) => READABLE_EXTENSIONS.has(extensionOf(file)));
    if (relative === undefined) return {};

    const recognized = await recognizer.recognize(vault.absoluteOf(relative));
    const receipt = receiptFromText(recognized.text);
    const merchantKey = receipt.merchant === undefined ? undefined : merchantKeyOf(receipt.merchant);
    return {
      ...(receipt.amount !== undefined ? { amount: receipt.amount } : {}),
      ...(receipt.currency !== undefined ? { currency: receipt.currency } : {}),
      ...(receipt.merchant !== undefined ? { merchant: receipt.merchant } : {}),
      ...(merchantKey !== undefined && merchantKey !== '' ? { merchantKey } : {}),
    };
  } catch (error) {
    // Recognized text is private; log only the failure kind.
    log.warn('receipts: text recognition of a saved file failed', { error: errorName(error) });
    return {};
  }
}
