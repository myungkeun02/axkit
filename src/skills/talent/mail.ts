import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Contracts } from '../../core/contracts/index.js';
import type { MailMessage } from '../../core/contracts/index.js';
import type { MailIntent } from '../../core/contracts/mail-intents.js';
import type { TalentIntake } from '../../core/contracts/talent.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { TalentStore } from './store.js';
import type { TalentBook } from './requests.js';
import { extractRequests } from './request-extract.js';
import { matchRequest } from './match.js';

const MAX_RESUME_BYTES = 10_000_000;
const MAX_RESUMES_PER_MAIL = 5;
const TEXT_CHARS = 16_000;
const WORD = /\.(docx?|rtf|odt)$/i;
const PDF = /\.pdf$/i;
const PLAIN = /\.(txt|md)$/i;

/** Text of one attached file; PDF needs the on-device reader, Word files macOS textutil. Nothing leaves the Mac. */
async function attachmentText(ctx: PluginContext, name: string, data: Uint8Array): Promise<string | undefined> {
  if (PLAIN.test(name)) return Buffer.from(data).toString('utf8').slice(0, TEXT_CHARS);
  if (!PDF.test(name) && !WORD.test(name)) return undefined;
  const dir = await mkdtemp(join(tmpdir(), 'ax-kit-resume-'));
  const path = join(dir, PDF.test(name) ? 'file.pdf' : `file${name.slice(name.lastIndexOf('.'))}`);
  try {
    await writeFile(path, data, { mode: 0o600 });
    if (PDF.test(name)) {
      const ocr = ctx.tryUse(Contracts.ocr);
      return ocr === undefined ? undefined : (await ocr.recognize(path, { maxPages: 6 })).text.slice(0, TEXT_CHARS);
    }
    const result = await nodeProcessRunner('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '--', path], { timeoutMs: 20_000 });
    return result.code === 0 && !result.timedOut ? result.stdout.slice(0, TEXT_CHARS) : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** "application": someone sent their résumé; its attachments go to the candidate list. */
export function applicationIntent(ctx: PluginContext, intake: TalentIntake, korean: boolean): MailIntent {
  return {
    id: 'application',
    description: 'someone sends their own résumé or CV, applies for a job, or a partner forwards a candidate’s résumé',
    async handle(mail: MailMessage) {
      const reader = ctx.tryUse(Contracts.mailAttachments);
      if (reader === undefined) return undefined;
      const files = (await reader.list(mail.id)).filter((file) => (PDF.test(file.filename) || WORD.test(file.filename) || PLAIN.test(file.filename)) && file.size <= MAX_RESUME_BYTES).slice(0, MAX_RESUMES_PER_MAIL);
      let added = 0;
      for (const file of files) {
        const sourceId = `mail:${mail.id}:${file.id}`;
        const at = mail.receivedAt.toISOString();
        if (!(await intake.wants(sourceId, at))) continue;
        const text = await attachmentText(ctx, file.filename, await reader.download(mail.id, file.id, MAX_RESUME_BYTES)).catch(() => undefined);
        if (text === undefined) continue;
        const result = await intake.add({ sourceId, path: `${korean ? '메일' : 'mail'}: ${mail.subject} · ${file.filename}`, source: 'mail', modifiedAt: at, text });
        if (result !== 'skipped') added += 1;
      }
      if (added === 0) return undefined;
      return korean ? `메일에 온 이력서 ${added}개를 후보자 명부에 넣었어요.` : `Added ${added} résumés from the mail to the candidate list.`;
    },
  };
}

/**
 * "hiring_request": a company asks for people. The positions go to the request book, and the reply draft learns how
 * many people fit and why, without names (the owner decides whom to introduce).
 */
export function hiringIntent(ctx: PluginContext, store: TalentStore, book: TalentBook, korean: boolean): MailIntent {
  return {
    id: 'hiring_request',
    description: 'a company or client asks the owner to find or recommend people for a position',
    async handle(mail: MailMessage) {
      const drafts = await extractRequests({ llm: ctx.llm, log: ctx.log }, mail);
      if (drafts === undefined || drafts.length === 0) return undefined;
      const saved = [];
      for (const draft of drafts) saved.push((await book.upsertRequest(draft, ctx.clock.now())).request);
      const list = saved.map((request) => `${request.company} · ${request.title}`).join(', ');
      return korean ? `채용 요청 ${saved.length}건을 등록했어요: ${list}` : `Saved ${saved.length} hiring requests: ${list}`;
    },
    async context(mail: MailMessage) {
      const requests = book.listRequests({ status: 'active' }).filter((request) => request.mailId === mail.id);
      if (requests.length === 0) return undefined;
      const parts: string[] = [];
      for (const request of requests) {
        const result = await matchRequest({ llm: ctx.llm, log: ctx.log, korean }, store, book, request, 5);
        const lines = result.matches.map(({ candidate, fit, why }, index) =>
          `${index + 1}. ${candidate.headline}${candidate.years !== undefined ? ` · ${candidate.years}y` : ''} (fit ${fit}): ${why}`,
        );
        parts.push(
          `${request.company} — ${request.title}: ${result.matches.length} people in the owner's list may fit` +
            (result.skipped.length > 0 ? ` (${result.skipped.length} more were already introduced there)` : '') +
            (lines.length > 0 ? `\n${lines.join('\n')}` : ''),
        );
      }
      return `${parts.join('\n\n')}\nDo not name anyone in the reply; say fitting profiles will follow after the owner checks.`;
    },
  };
}
