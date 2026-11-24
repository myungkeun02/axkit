import type {
  MailAttachment,
  MailAttachmentReader,
  MailMessage,
} from '../../core/contracts/mail.js';
import { extensionOf } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import { ymdOf } from '../../core/time/local-day.js';
import type { DocKind } from './types.js';
import type { Vault, VaultFile } from './vault.js';
import { safeName } from './vault.js';

const ALLOWED_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'heic', 'gif', 'txt', 'csv', 'html', 'xml']);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

export interface SaveDeps {
  vault: Vault;
  timeZone: string;
  log: Logger;
  attachments?: MailAttachmentReader;
}

export interface SaveResult {
  files: string[];
  skippedAttachments: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function mailText(message: MailMessage): string {
  return [
    `From: ${oneLine(message.from)}`,
    `Date: ${message.receivedAt.toISOString()}`,
    `Subject: ${oneLine(message.subject)}`,
    '',
    message.body,
  ].join('\n');
}

function allowed(attachment: MailAttachment): boolean {
  return ALLOWED_EXTENSIONS.has(extensionOf(attachment.filename));
}

async function attachmentFiles(deps: SaveDeps, message: MailMessage): Promise<{
  files: VaultFile[];
  skipped: number;
}> {
  const reader = deps.attachments;
  if (reader === undefined) return { files: [], skipped: 0 };

  let listed: MailAttachment[];
  try {
    listed = await reader.list(message.id);
  } catch (error) {
    deps.log.warn('receipts: attachment list failed', { error: errorName(error) });
    return { files: [], skipped: 0 };
  }

  const files: VaultFile[] = [];
  let skipped = 0;
  for (const attachment of listed) {
    if (files.length >= MAX_ATTACHMENTS) {
      skipped += 1;
      continue;
    }
    if (!allowed(attachment) || attachment.size > MAX_ATTACHMENT_BYTES) {
      skipped += 1;
      continue;
    }
    try {
      const data = await reader.download(message.id, attachment.id, MAX_ATTACHMENT_BYTES);
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        skipped += 1;
        continue;
      }
      const index = files.length + 1;
      files.push({ name: safeName(`att-${index}-${attachment.filename}`) || `att-${index}`, data });
    } catch (error) {
      skipped += 1;
      deps.log.warn('receipts: attachment download failed', { error: errorName(error) });
    }
  }
  return { files, skipped };
}

/** Copies one classified mail (and its readable attachments) into the vault; the index is written by the caller. */
export async function saveMailDocument(
  deps: SaveDeps,
  message: MailMessage,
  kind: DocKind,
): Promise<SaveResult> {
  if (!deps.vault.enabled) return { files: [], skippedAttachments: 0 };

  const attachments = await attachmentFiles(deps, message);
  const files = await deps.vault.writeDoc(ymdOf(message.receivedAt, deps.timeZone), kind, message.subject, message.id, [
    { name: 'mail.txt', data: mailText(message) },
    ...attachments.files,
  ]);
  return { files, skippedAttachments: attachments.skipped };
}
