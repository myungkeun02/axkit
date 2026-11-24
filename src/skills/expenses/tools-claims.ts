import { z } from 'zod';
import type { SpendCategory, SpendEntry } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { monthPlus, monthRange } from '../../core/time/local-day.js';
import type { Candidate, CandidateReason, RuleTotal } from './candidates.js';
import { YM } from './config.js';
import { currentMonth, messageOf } from './deps.js';
import type { ExpenseDeps } from './deps.js';
import { buildClaimMail, stripCardNumbers } from './mail.js';
import { loadReport } from './report.js';
import type { LoadedReport } from './report.js';

const LOOKBACK_MONTHS = 12;

const monthField = z.string().regex(YM).optional().describe('Month as YYYY-MM; defaults to the current month.');

export interface CandidateItemOutput {
  entryId: string;
  at: string;
  merchant: string;
  amount: number;
  currency: string;
  category: SpendCategory;
  ruleId?: string;
  ruleName?: string;
  reason: CandidateReason;
}

export interface CandidatesOutput {
  month: string;
  currency: string;
  candidates: CandidateItemOutput[];
  unsure: CandidateItemOutput[];
  totals: RuleTotal[];
  candidateCount: number;
  unsureCount: number;
  grandTotal: number;
}

export interface SummaryOutput {
  month: string;
  currency: string;
  totals: RuleTotal[];
  candidateCount: number;
  unsureCount: number;
  grandTotal: number;
}

export type DraftClaimOutput =
  | { status: 'no_recipient'; hint: string }
  | { subject: string; body: string }
  | {
      draftId: string;
      to: readonly string[];
      cc: readonly string[];
      subject: string;
      body: string;
      note: string;
    };

function itemOut(item: Candidate, homeCurrency: string, deps: ExpenseDeps): CandidateItemOutput {
  const merchant = stripCardNumbers(item.entry.merchant);
  return {
    entryId: item.entry.id,
    at: item.entry.at,
    merchant: merchant === '' ? deps.texts.unknownMerchant : merchant,
    amount: item.entry.amount,
    currency: homeCurrency,
    category: item.entry.category,
    ...(item.ruleId !== undefined ? { ruleId: item.ruleId } : {}),
    ...(item.ruleName !== undefined ? { ruleName: item.ruleName } : {}),
    reason: item.reason,
  };
}

function candidatesOutput(loaded: LoadedReport, deps: ExpenseDeps): CandidatesOutput {
  const { report } = loaded;
  return {
    month: loaded.month,
    currency: loaded.currency,
    candidates: report.items
      .filter((item) => item.status === 'candidate')
      .map((item) => itemOut(item, loaded.currency, deps)),
    unsure: report.items
      .filter((item) => item.status === 'unsure')
      .map((item) => itemOut(item, loaded.currency, deps)),
    totals: report.totals,
    candidateCount: report.candidateCount,
    unsureCount: report.unsureCount,
    grandTotal: report.grandTotal,
  };
}

async function findEntry(ctx: PluginContext, entryId: string): Promise<SpendEntry | undefined> {
  const reader = ctx.tryUse(Contracts.spendRead);
  if (reader === undefined) return undefined;
  const timeZone = ctx.assistant.timezone;
  let month = currentMonth(ctx);
  for (let step = 0; step < LOOKBACK_MONTHS; step += 1) {
    try {
      const entries = await reader.entries(monthRange(month, timeZone));
      const hit = entries.find((entry) => entry.id === entryId);
      if (hit !== undefined) return hit;
    } catch (error) {
      ctx.log.warn('expenses: entry lookup failed', { error: messageOf(error) });
      return undefined;
    }
    month = monthPlus(month, -1);
  }
  return undefined;
}

const markInput = z.object({
  entryId: z.string().min(1).max(120).describe('Spend entry id from expenses.candidates.'),
  decision: z.enum(['claim', 'personal']).describe('"claim" includes it in the claim mail; "personal" leaves it out.'),
  remember: z.boolean().default(true).describe('Remember this merchant decision for later entries too.'),
  ruleId: z.string().min(1).max(41).optional().describe('Rule id to attach when known.'),
});

const draftInput = z.object({
  month: monthField,
  to: z.array(z.email()).min(1).max(20).optional().describe('Override the configured claim recipients.'),
});

/** Registers candidate, marking, summary and draft tools. */
export function registerClaimTools(ctx: PluginContext, deps: ExpenseDeps): void {
  ctx.registerTool({
    name: 'expenses.candidates',
    description:
      'List a month\'s claim candidates and the entries that need a yes/no from the owner (first-seen work tools).',
    input: z.object({ month: monthField }),
    effects: ['read'],
    async run(input) {
      const loaded = await loadReport(ctx, deps, input.month);
      if (loaded === undefined) throw new Error(deps.texts.notConnected);
      return candidatesOutput(loaded, deps);
    },
  });

  ctx.registerTool({
    name: 'expenses.mark',
    description:
      'Mark one spend entry as claim or personal. With remember, the merchant decision applies to later entries too.',
    input: markInput,
    effects: ['write'],
    describe: (input) => deps.texts.describeMark(input.entryId, input.decision),
    async run(input) {
      const entry = await findEntry(ctx, input.entryId);
      const merchantKey = entry?.merchantKey;
      const remember = input.remember && merchantKey !== undefined && merchantKey !== '';
      await deps.decisions.mark({
        entryId: input.entryId,
        ...(remember ? { merchantKey } : {}),
        decision: input.decision,
        ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
        at: ctx.clock.now(),
      });
      return { entryId: input.entryId, decision: input.decision, remembered: remember };
    },
  });

  ctx.registerTool({
    name: 'expenses.summary',
    description: 'Per-rule claim totals, the unsure count and the grand total for a month.',
    input: z.object({ month: monthField }),
    effects: ['read'],
    async run(input): Promise<SummaryOutput> {
      const loaded = await loadReport(ctx, deps, input.month);
      if (loaded === undefined) throw new Error(deps.texts.notConnected);
      const { report } = loaded;
      return {
        month: loaded.month,
        currency: loaded.currency,
        totals: report.totals,
        candidateCount: report.candidateCount,
        unsureCount: report.unsureCount,
        grandTotal: report.grandTotal,
      };
    },
  });

  ctx.registerTool({
    name: 'expenses.draft_claim_mail',
    description:
      'Create a claim mail draft for a month from candidate entries. It is only a draft; sending needs mail.send_draft approval.',
    input: draftInput,
    effects: ['write'],
    describe(input) {
      const month = input.month ?? currentMonth(ctx);
      const to = input.to ?? deps.config.claimTo;
      const subject = deps.texts.claimSubject(deps.config.companyLabel, month);
      const cached = deps.cache.total(month);
      const total = cached === undefined ? deps.texts.totalPending : deps.texts.money(cached.total, cached.currency);
      return deps.texts.describeDraft(to, subject, total);
    },
    async run(input): Promise<DraftClaimOutput> {
      const loaded = await loadReport(ctx, deps, input.month);
      if (loaded === undefined) throw new Error(deps.texts.notConnected);
      const to = input.to ?? deps.config.claimTo;
      if (to.length === 0) return { status: 'no_recipient', hint: deps.texts.noRecipientHint };
      const mail = buildClaimMail(loaded.report, {
        timeZone: ctx.assistant.timezone,
        ...(deps.config.companyLabel !== undefined ? { companyLabel: deps.config.companyLabel } : {}),
        ...(ctx.assistant.ownerName !== undefined ? { ownerName: ctx.assistant.ownerName } : {}),
        texts: deps.texts,
      });
      const composer = ctx.tryUse(Contracts.mailCompose);
      if (composer === undefined) {
        return { subject: mail.subject, body: mail.body };
      }
      const draft = await composer.draftNew({ to, cc: deps.config.claimCc, subject: mail.subject, body: mail.body });
      return {
        draftId: draft.draftId,
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        body: draft.body,
        note: deps.texts.draftNote,
      };
    },
  });
}
