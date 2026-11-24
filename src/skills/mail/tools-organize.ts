import { z } from 'zod';
import type { MailOrganizer } from '../../core/contracts/index.js';
import { Contracts, MAIL_ORGANIZE_MAX, MailPermissionError, ORGANIZE_SYSTEM_LABELS } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { AutonomyScope } from '../../core/policy/autonomy.js';
import type { Tool } from '../../core/tools/types.js';
import type { OrganizeTexts } from './organize-locale.js';
import { bareAddress } from './triage-config.js';
import { senderName } from './triage-locale.js';

const CARD_MAILS = 5;
const CARD_SUBJECT_CHARS = 80;
const FORBIDDEN = new Set(['trash', 'spam', 'draft', 'sent', 'chat']);
/** Shared mailbox domains: "everything from gmail.com" is not a narrow rule, so those fall back to one sender. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
  'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com',
]);

const mailRef = z.object({
  id: z.string().min(1).max(200),
  from: z.string().max(300).describe('The sender exactly as mail.search returned it.'),
  subject: z.string().max(500).describe('The subject exactly as mail.search returned it.'),
  category: z.enum(['promotions', 'social', 'updates', 'forums']).optional().describe('Copy it when mail.search gave one.'),
});
const mailList = z
  .array(mailRef)
  .min(1)
  .max(MAIL_ORGANIZE_MAX)
  .describe(`Up to ${MAIL_ORGANIZE_MAX} mails, each copied from mail.search: id, from, subject (and category).`);
const labelName = z.string().trim().min(1).max(100);

const labelsInput = z.object({});
const archiveInput = z.object({ mails: mailList });
const labelInput = z.object({
  mails: mailList,
  add: z.array(labelName).max(5).optional().describe('Label names to add; a missing owner label is created.'),
  remove: z.array(labelName).max(5).optional().describe('Label names to remove (INBOX = archive, UNREAD = mark read).'),
});

export type MailRef = z.infer<typeof mailRef>;
export type MailArchiveInput = z.infer<typeof archiveInput>;
export type MailLabelInput = z.infer<typeof labelInput>;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** "- 미나 (mina@example.com): 견적 회의" for the first five mails, then "외 N통". */
export function mailLines(mails: readonly MailRef[], texts: OrganizeTexts): string[] {
  const lines = mails.slice(0, CARD_MAILS).map((mail) => {
    const address = bareAddress(mail.from);
    const name = senderName(mail.from);
    const who = name.toLowerCase() === address || address === '' ? name : `${name} (${address})`;
    return `- ${who}: ${mail.subject.trim() === '' ? texts.noSubject : oneLine(mail.subject, CARD_SUBJECT_CHARS)}`;
  });
  if (mails.length > CARD_MAILS) lines.push(texts.more(mails.length - CARD_MAILS));
  return lines;
}

/** The narrowest honest "same kind": one Gmail category, else one company domain, else one sender. Never "all mail". */
export function mailScope(mails: readonly MailRef[], texts: OrganizeTexts): { key: string; who: string } | undefined {
  const categories = new Set(mails.map((mail) => mail.category));
  const [category] = [...categories];
  if (categories.size === 1 && category !== undefined) return { key: `category:${category}`, who: texts.categoryName(category) };
  const addresses = new Set(mails.map((mail) => bareAddress(mail.from)));
  const domains = new Set([...addresses].map((address) => address.split('@')[1] ?? ''));
  const [domain] = [...domains];
  if (domains.size === 1 && domain !== undefined && domain !== '' && !FREE_MAIL.has(domain)) {
    return { key: `domain:${domain}`, who: texts.fromWho(`@${domain}`) };
  }
  const [address] = [...addresses];
  if (addresses.size === 1 && address !== undefined && address.includes('@')) return { key: `sender:${address}`, who: texts.fromWho(address) };
  return undefined;
}

function same(left: string, right: string): boolean {
  return left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();
}

/**
 * The card and any standing rule were about what the model said these mails are; check that against the mailbox
 * before touching anything. Mails gone since are skipped.
 */
async function checked(organizer: MailOrganizer, mails: readonly MailRef[], texts: OrganizeTexts): Promise<{ ids: string[]; gone: number }> {
  const now = new Map((await organizer.peek(mails.map((mail) => mail.id))).map((summary) => [summary.id, summary]));
  const ids: string[] = [];
  for (const mail of mails) {
    const actual = now.get(mail.id);
    if (actual === undefined || ids.includes(mail.id)) continue;
    const category = mail.category === undefined || (actual.labels ?? []).includes(`CATEGORY_${mail.category.toUpperCase()}`);
    if (bareAddress(actual.from) !== bareAddress(mail.from) || !same(actual.subject, mail.subject) || !category) {
      throw new Error(texts.changed);
    }
    ids.push(mail.id);
  }
  return { ids, gone: new Set(mails.map((mail) => mail.id)).size - ids.length };
}

function organizerOf(ctx: PluginContext, texts: OrganizeTexts): MailOrganizer {
  const organizer = ctx.tryUse(Contracts.mailOrganize);
  if (organizer === undefined) throw new Error(texts.needsPermission);
  return organizer;
}

async function guarded<T>(texts: OrganizeTexts, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MailPermissionError) throw new Error(texts.needsPermission);
    throw error;
  }
}

function forbiddenLabel(names: readonly string[]): boolean {
  return names.some((name) => FORBIDDEN.has(name.trim().toLowerCase()) || name.trim().toLowerCase() === '휴지통');
}

/** Tool "mail.labels": the owner's labels and the system ones organizing may use. */
export function mailLabelsTool(ctx: PluginContext, texts: OrganizeTexts): Tool<z.infer<typeof labelsInput>, { name: string; system: boolean }[]> {
  return {
    name: 'mail.labels',
    description: 'List the Gmail labels mail.label can add or remove (the owner\'s own and INBOX, UNREAD, STARRED, IMPORTANT).',
    input: labelsInput,
    effects: ['read'],
    async run() {
      const organizer = organizerOf(ctx, texts);
      const labels = await guarded(texts, () => organizer.labels());
      return labels
        .filter((label) => !label.system || ORGANIZE_SYSTEM_LABELS.includes(label.id))
        .map((label) => ({ name: label.name, system: label.system }));
    },
  };
}

/** Tool "mail.archive": out of the inbox only; the mail stays in the mailbox and is never deleted. */
export function mailArchiveTool(ctx: PluginContext, texts: OrganizeTexts): Tool<MailArchiveInput, { archived: number; gone: number }> {
  return {
    name: 'mail.archive',
    description:
      'Archive mails (take them out of the inbox; nothing is deleted). Pass each mail exactly as mail.search returned it. ' +
      `At most ${MAIL_ORGANIZE_MAX} per call. Never use it for mail the owner did not ask to clear.`,
    input: archiveInput,
    effects: ['write'],
    reject: () => (ctx.tryUse(Contracts.mailOrganize) === undefined ? texts.needsPermission : undefined),
    describe: (input) => [texts.archiveLabel(input.mails.length), ...mailLines(input.mails, texts)].join('\n'),
    autonomyScope(input): AutonomyScope | undefined {
      const scope = mailScope(input.mails, texts);
      return scope === undefined ? undefined : { key: `archive|${scope.key}`, label: texts.archiveScope(scope.who) };
    },
    async run(input) {
      const organizer = organizerOf(ctx, texts);
      return await guarded(texts, async () => {
        const { ids, gone } = await checked(organizer, input.mails, texts);
        if (ids.length > 0) await organizer.archive(ids);
        return { archived: ids.length, gone };
      });
    },
  };
}

function labelChange(input: MailLabelInput): string {
  const add = (input.add ?? []).map((name) => `+${name}`);
  const remove = (input.remove ?? []).map((name) => `-${name}`);
  return [...add, ...remove].join(' ');
}

/** Tool "mail.label": add or remove labels; a missing owner label is created first. */
export function mailLabelTool(
  ctx: PluginContext,
  texts: OrganizeTexts,
): Tool<MailLabelInput, { changed: number; gone: number; created: string[] }> {
  return {
    name: 'mail.label',
    description:
      'Add or remove Gmail labels on mails, copied exactly from mail.search. A missing label to add is created. ' +
      'Removing INBOX archives, removing UNREAD marks read. Trash and spam are not reachable.',
    input: labelInput,
    effects: ['write'],
    reject(input) {
      if (ctx.tryUse(Contracts.mailOrganize) === undefined) return texts.needsPermission;
      const names = [...(input.add ?? []), ...(input.remove ?? [])];
      if (names.length === 0) return texts.nothingToChange;
      return forbiddenLabel(names) ? texts.forbidden : undefined;
    },
    describe(input) {
      const lines: string[] = [];
      if ((input.add ?? []).length > 0) lines.push(texts.addLabel((input.add ?? []).join(', ')));
      if ((input.remove ?? []).length > 0) lines.push(texts.removeLabel((input.remove ?? []).join(', ')));
      return [...lines, ...mailLines(input.mails, texts)].join('\n');
    },
    autonomyScope(input): AutonomyScope | undefined {
      const scope = mailScope(input.mails, texts);
      if (scope === undefined) return undefined;
      const change = labelChange(input);
      return { key: `label|${scope.key}|${change.toLowerCase()}`, label: texts.labelScope(scope.who, change) };
    },
    async run(input) {
      const organizer = organizerOf(ctx, texts);
      return await guarded(texts, async () => {
        const existing = await organizer.labels();
        const has = (name: string): boolean =>
          existing.some((label) => label.name.toLowerCase() === name.toLowerCase() || label.id.toLowerCase() === name.toLowerCase());
        const missingRemove = (input.remove ?? []).find((name) => !has(name));
        if (missingRemove !== undefined) throw new Error(texts.unknownLabel(missingRemove));
        const { ids, gone } = await checked(organizer, input.mails, texts);
        const created: string[] = [];
        if (ids.length === 0) return { changed: 0, gone, created };
        for (const name of input.add ?? []) {
          if (has(name)) continue;
          created.push((await organizer.createLabel(name)).name);
        }
        if ((input.add ?? []).length > 0) await organizer.addLabels(ids, input.add ?? []);
        if ((input.remove ?? []).length > 0) await organizer.removeLabels(ids, input.remove ?? []);
        return { changed: ids.length, gone, created };
      });
    },
  };
}
