import { z } from 'zod';
import type { MailDraft } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import type { MailTexts } from './locale.js';
import { bareAddress } from './triage-config.js';
import { MUTED_KEY, mutedSenders } from './triage-job.js';
import type { TriageTexts } from './triage-locale.js';

const MAX_CARD_BODY_CHARS = 1_500;
const MAX_MUTED = 500;

const composeInput = z.object({
  to: z.array(z.email()).min(1).max(20).describe('Recipient email addresses.'),
  cc: z.array(z.email()).max(20).optional(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
});

const muteInput = z.object({ email: z.email().describe('The sender address mail triage should ignore from now on.') });

export type MailComposeInput = z.infer<typeof composeInput>;
export type MailMuteInput = z.infer<typeof muteInput>;

/** Tool "mail.compose": a new draft in the owner's mailbox. Sending stays with mail.send_draft and its card. */
export function mailComposeTool(ctx: PluginContext, texts: MailTexts, triage: TriageTexts): Tool<MailComposeInput, MailDraft> {
  return {
    name: 'mail.compose',
    description:
      'Create a new mail draft (not a reply) in the owner mailbox. Nothing is sent; pass the returned draft to ' +
      'mail.send_draft exactly as returned when the owner wants it sent.',
    input: composeInput,
    effects: ['write'],
    describe(input) {
      const cc = input.cc !== undefined && input.cc.length > 0 ? input.cc.join(', ') : texts.none;
      return [
        triage.composeLabel,
        `${texts.toLabel}: ${input.to.join(', ')}`,
        `${texts.ccLabel}: ${cc}`,
        `${texts.subjectLabel}: ${input.subject}`,
        `${texts.bodyLabel}:`,
        input.body.length > MAX_CARD_BODY_CHARS ? `${input.body.slice(0, MAX_CARD_BODY_CHARS)}${texts.truncatedSuffix}` : input.body,
      ].join('\n');
    },
    async run(input) {
      const composer = ctx.tryUse(Contracts.mailCompose);
      if (composer === undefined) throw new Error('mail compose is not connected; reconnect Google with Gmail');
      return composer.draftNew({
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.cc !== undefined ? { cc: input.cc } : {}),
      });
    },
  };
}

/** Tool "mail.mute_sender": triage stops looking at this sender (no notice, digest line or suggestion). */
export function mailMuteSenderTool(ctx: PluginContext, texts: TriageTexts): Tool<MailMuteInput, { muted: string; already: boolean }> {
  return {
    name: 'mail.mute_sender',
    description: 'Stop mail triage (important-mail notices, digests, suggestions) for one sender. The mail itself stays.',
    input: muteInput,
    effects: ['write'],
    describe: (input) => `${texts.muteLabel}: ${bareAddress(input.email)}`,
    async run(input) {
      const address = bareAddress(input.email);
      const muted = await mutedSenders(ctx.kv);
      if (muted.includes(address)) return { muted: address, already: true };
      await ctx.kv.set(MUTED_KEY, [...muted, address].slice(-MAX_MUTED));
      return { muted: address, already: false };
    },
  };
}
