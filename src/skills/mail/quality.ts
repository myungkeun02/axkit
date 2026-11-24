import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { MailMessage } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { checkOutcomes, draftStats, evalCases, similarity } from './draft-outcomes.js';
import { writeDraft } from './draft-writer.js';
import { learnStyle, readStyle } from './style.js';

const CHECK_JOB = 'mail.drafts.check';
const EVAL_KEY = 'eval-last';
const STYLE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const EVAL_CASES = 20;

const EvalSchema = z.object({ at: z.string(), cases: z.number(), now: z.number(), before: z.number() });
type EvalRun = z.infer<typeof EvalSchema>;

function caseMessage(text: string, index: number): MailMessage {
  const from = /^From: (.*)$/m.exec(text)?.[1] ?? '';
  const subject = /^Subject: (.*)$/m.exec(text)?.[1] ?? '';
  const body = text.split('\n\n').slice(1).join('\n\n');
  return { id: `eval-${index}`, threadId: `eval-${index}`, from, to: [], cc: [], subject, snippet: '', body, receivedAt: new Date(0), unread: false, important: false };
}

/**
 * Replays the local test set: for each real mail the owner answered, the current drafting (model, style guide) writes a
 * draft, scored by how close it is to what the owner actually sent — against how close the original draft was.
 */
export async function runDraftEval(ctx: PluginContext): Promise<EvalRun | undefined> {
  const cases = (await evalCases(ctx)).slice(-EVAL_CASES);
  if (cases.length === 0) return undefined;
  let now = 0;
  let before = 0;
  for (const [index, item] of cases.entries()) {
    const plan = await writeDraft(ctx, { message: caseMessage(item.mail, index), triage: { importance: 'normal', kind: item.kind, summary: '', actions: [] }, baseline: item.ours, docs: [] });
    now += similarity(plan.body, item.sent);
    before += similarity(item.ours, item.sent);
  }
  const run: EvalRun = { at: ctx.clock.now().toISOString(), cases: cases.length, now: Math.round((now / cases.length) * 100) / 100, before: Math.round((before / cases.length) * 100) / 100 };
  await ctx.kv.set(EVAL_KEY, run);
  return run;
}

/** Daily: what happened to the drafts, and a fresh style guide weekly or when the owner edited drafts. */
export function registerQuality(ctx: PluginContext): void {
  ctx.scheduler.add({
    name: CHECK_JOB,
    label: ctx.assistant.language === 'en' ? 'Learn from sent drafts' : '보낸 초안에서 배우기',
    schedule: { kind: 'daily', at: '05:10' },
    run: async () => {
      const { edits } = await checkOutcomes(ctx);
      const style = await readStyle(ctx);
      const stale = style === undefined || ctx.clock.now().getTime() - Date.parse(style.learnedAt) > STYLE_EVERY_MS;
      if (edits.length > 0 || stale) await learnStyle(ctx, edits);
    },
  });
}

const empty = z.object({}).strict() as unknown as z.ZodType<Record<string, never>>;

export function qualityTools(ctx: PluginContext): Tool<Record<string, never>, Record<string, unknown>>[] {
  return [
    {
      name: 'mail.draft_stats',
      description: 'How the automatic reply drafts did in the last 30 days (sent as is, edited, not sent), the learned writing style and the last test-set score.',
      input: empty,
      effects: ['read'],
      async run() {
        const last = EvalSchema.safeParse(await ctx.kv.get<unknown>(EVAL_KEY));
        const style = await readStyle(ctx);
        return {
          ...(await draftStats(ctx)),
          ...(style !== undefined ? { style: { learnedAt: style.learnedAt, samples: style.samples, edits: style.edits, guide: style.guide } } : {}),
          testCases: (await evalCases(ctx)).length,
          ...(last.success ? { lastEval: last.data } : {}),
        };
      },
    },
    {
      name: 'mail.draft_eval',
      description:
        'Re-run the local test set (real mails the owner answered) with the current drafting and score how close the new drafts come to what the owner sent, against the old drafts. Uses one model call per case (at most 20).',
      input: empty,
      effects: ['read'],
      async run() {
        const run = await runDraftEval(ctx);
        return run === undefined ? { cases: 0 } : { ...run };
      },
    },
  ];
}

/** View "mail-quality": the numbers for the app's settings screen. */
export function registerQualityView(ctx: PluginContext): void {
  ctx.bus.on('app.started', () => {
    const views = ctx.tryUse(Contracts.appViews);
    if (views === undefined) return;
    views.register({
      name: 'mail-quality',
      version: 1,
      // drawn by the server as blocks, so every app shows it under 새 기능 without its own screen
      ui: 'blocks',
      title: '메일 초안 품질',
      icon: 'envelope.badge',
      async read() {
        const last = EvalSchema.safeParse(await ctx.kv.get<unknown>(EVAL_KEY));
        const style = await readStyle(ctx);
        const stats = await draftStats(ctx);
        const blocks = [
          { kind: 'text', text: '지난 30일 동안 비서가 쓴 메일 답장 초안이 어떻게 쓰였는지예요.' },
          { kind: 'stat', title: '쓴 초안', value: `${stats.drafted}개` },
          { kind: 'list', rows: [
            { title: '그대로 보냄', trailing: `${stats.asIs}` },
            { title: '고쳐서 보냄', trailing: `${stats.edited}` },
            { title: '보내지 않음', trailing: `${stats.unsent}` },
            { title: '아직 모름', trailing: `${stats.pending}` },
          ] },
          ...(style !== undefined ? [{ kind: 'text', text: `말투를 ${style.samples}통에서 배웠어요 (${style.learnedAt.slice(0, 10)}).` }] : []),
        ];
        return {
          title: '메일 초안 품질',
          blocks,
          ...stats,
          ...(style !== undefined ? { style: { learnedAt: style.learnedAt, samples: style.samples, edits: style.edits, guide: style.guide } } : {}),
          testCases: (await evalCases(ctx)).length,
          ...(last.success ? { lastEval: last.data } : {}),
        };
      },
    });
    views.addFeature?.('mail-quality');
  });
}
