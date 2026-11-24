import { Contracts } from '../../core/contracts/index.js';
import type { MailMessage } from '../../core/contracts/index.js';
import type { MailIntent } from '../../core/contracts/mail-intents.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ToolCallContext } from '../../core/tools/types.js';
import { offerSuggestions, sendDrafted } from './triage-actions.js';
import { findRequested, freeSlots } from './draft-context.js';
import type { FoundDoc } from './draft-context.js';
import { writeDraft } from './draft-writer.js';
import { needsReply } from './safety.js';
import { rememberAttachments } from './attachment-memory.js';
import { recordDraft } from './draft-outcomes.js';
import type { TriageTexts } from './triage-locale.js';
import { senderName } from './triage-locale.js';
import type { ReplySuggestion, Triage } from './triage-model.js';
import { mailGrounding } from './triage-model.js';

export interface HandleOptions {
  autoDraft: boolean;
  intents: readonly MailIntent[];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function tell(ctx: PluginContext, text: string, dedupeKey: string): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'mail.triage', text, dedupeKey }).catch(() => undefined);
}

/**
 * One triaged mail, after the sweep: a pack's own work for its kind (read attached résumés…), then — with autoDraft —
 * a reply draft written right away with the files, free times and facts it needs, so the owner only decides whether
 * to send it. Event and to-do suggestions still ask first.
 */
export async function handleMail(ctx: PluginContext, message: MailMessage, triage: Triage, texts: TriageTexts, options: HandleOptions): Promise<void> {
  // what the attached files say is kept, so a later question about them has an answer
  await rememberAttachments(ctx, message).catch(() => 0);
  const intent = options.intents.find((item) => item.id === triage.kind);
  if (intent?.handle !== undefined) {
    try {
      const line = await intent.handle(message, triage.summary);
      if (line !== undefined) await tell(ctx, line, `intent:${intent.id}:${message.id}`);
    } catch (error) {
      ctx.log.warn('mail triage: an intent handler failed', { intent: intent.id, error: errorName(error) });
    }
  }
  // a robot sender, a list or a notice is not waiting for an answer: its reply suggestion is dropped
  const wanted = needsReply(message, triage.kind);
  const actions = wanted ? triage.actions : triage.actions.filter((action) => action.kind !== 'reply');
  const reply = actions.find((action): action is ReplySuggestion => action.kind === 'reply');
  if (!options.autoDraft || reply === undefined) {
    await offerSuggestions(ctx, message, actions, texts);
    return;
  }
  await draftNow(ctx, message, triage, reply, intent, texts);
  await offerSuggestions(
    ctx,
    message,
    actions.filter((action) => action.kind !== 'reply'),
    texts,
  );
}

async function draftNow(ctx: PluginContext, message: MailMessage, triage: Triage, reply: ReplySuggestion, intent: MailIntent | undefined, texts: TriageTexts): Promise<void> {
  const call: ToolCallContext = { grounding: mailGrounding(message) };
  let docs: FoundDoc[] = [];
  if (triage.kind === 'document_request' && triage.wants !== undefined) {
    docs = await findRequested(ctx, triage.wants, call).catch(() => []);
  }
  const slots = triage.kind === 'scheduling' ? await freeSlots(ctx, ctx.clock.now()) : undefined;
  let extra: string | undefined;
  if (intent?.context !== undefined) extra = await intent.context(message, triage.summary).catch(() => undefined);
  const plan = await writeDraft(ctx, {
    message,
    triage,
    baseline: reply.body,
    docs,
    ...(slots !== undefined ? { slots } : {}),
    ...(extra !== undefined ? { extra } : {}),
  });
  const drafted = await ctx.tools.execute(
    'mail.draft_reply',
    { messageId: message.id, body: plan.body, ...(plan.attach.length > 0 ? { attachments: plan.attach } : {}) },
    call,
  );
  if (drafted.status !== 'done') {
    ctx.log.warn('mail triage: the automatic draft did not run', { status: drafted.status });
    return;
  }
  const draftId = typeof (drafted.output as { draftId?: unknown } | undefined)?.draftId === 'string' ? (drafted.output as { draftId: string }).draftId : undefined;
  if (draftId !== undefined) await recordDraft(ctx, { draftId, messageId: message.id, threadId: message.threadId, kind: triage.kind, body: plan.body }).catch(() => undefined);
  const who = senderName(message.from);
  const missing = triage.kind === 'document_request' && plan.attach.length === 0;
  const lines = [texts.drafted(who), ...(plan.attach.length > 0 ? [texts.attachedFiles(plan.attach)] : []), ...(missing ? [texts.fileNotFound(triage.wants ?? '')] : []), ...(plan.unsupported.length > 0 ? [texts.checkFacts(plan.unsupported)] : []), ...(plan.note !== '' ? [plan.note] : [])];
  await tell(ctx, lines.join('\n'), `drafted:${message.id}`);
  await sendDrafted(ctx, drafted.output, message, texts, call);
}
