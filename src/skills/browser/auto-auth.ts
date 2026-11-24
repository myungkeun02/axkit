import { z } from 'zod';
import type { AuthStep, BrowserAuthHelper } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import { Caps } from '../../core/plugin/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { decideAutoAuth, extractMailStep, fromDomain, hostOf, registrableDomain } from './auth-rules.js';
import type { BrowserTexts } from './locale.js';

export const autoAuthSchema = z.object({
  /** Off until the owner turns it on. */
  enabled: z.boolean().default(false),
  /** Sites (host or registrable domain) where codes may be typed. Empty means nowhere. */
  sites: z.array(z.string().min(1).max(253)).max(100).default([]),
  /** Also read the site's own verification mail (needs mail.read). */
  email: z.boolean().default(false),
  /** More sites that always need the owner's card first, on top of the built-in money-grade list. */
  financialSites: z.array(z.string().min(1).max(253)).max(100).default([]),
});

export type AutoAuthSettings = z.infer<typeof autoAuthSchema>;

/** A code older than the task (with this much slack for a slow phone) belongs to something else. */
const CLOCK_SLACK_MS = 60_000;
const CODE_MAX_AGE_MINUTES = 10;
const MAIL_LOOKBACK_HOURS = 1;

/**
 * Hands out one-time codes during one owner-approved browser task. Codes come from the phone vault (texts, 10 minutes)
 * or the site's own mail; money-grade sites and money-moving steps ask the owner first. Nothing here logs a code.
 */
export class TaskAuthHelper implements BrowserAuthHelper {
  private readonly startedAt: number;
  private readonly used = new Set<string>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly settings: AutoAuthSettings,
    private readonly texts: BrowserTexts,
    private readonly goal: string,
  ) {
    this.startedAt = ctx.clock.now().getTime();
  }

  async stepFor(pageUrl: string, pageText: string): Promise<AuthStep | undefined> {
    const decision = decideAutoAuth({
      pageUrl,
      pageText,
      goal: this.goal,
      sites: this.settings.sites,
      financialSites: this.settings.financialSites,
    });
    const host = hostOf(pageUrl) ?? '';
    this.ctx.log.info('browser: verification step', { host, decision });
    if (decision === 'not_allowed') return undefined;
    if (decision === 'confirm' && !(await this.ownerAgrees(host))) return undefined;

    const fromPhone = this.phoneCode();
    if (fromPhone !== undefined) return fromPhone;
    if (this.settings.email) return this.mailStep(host);
    return undefined;
  }

  private async ownerAgrees(host: string): Promise<boolean> {
    const confirmer = this.ctx.tryUse(Caps.confirmer);
    if (confirmer === undefined) return false;
    try {
      const answer = await confirmer.confirm({
        summary: this.texts.authConfirm(host),
        effects: ['write'],
        toolName: 'browser.task',
        note: this.texts.authConfirmNote,
      });
      return answer === 'approved';
    } catch {
      return false;
    }
  }

  private phoneCode(): AuthStep | undefined {
    const vault = this.ctx.tryUse(Contracts.phoneOtp);
    const latest = vault?.latest(CODE_MAX_AGE_MINUTES);
    if (latest === undefined) return undefined;
    if (latest.at.getTime() < this.startedAt - CLOCK_SLACK_MS) return undefined;
    if (this.used.has(latest.code)) return undefined;
    this.used.add(latest.code);
    return { kind: 'code', code: latest.code };
  }

  private async mailStep(host: string): Promise<AuthStep | undefined> {
    const mail = this.ctx.tryUse(Contracts.mailRead);
    if (mail === undefined || host === '') return undefined;
    const domain = registrableDomain(host);
    try {
      const found = await mail.search({ text: `from:${domain}`, sinceHours: MAIL_LOOKBACK_HOURS, limit: 3 });
      for (const summary of found) {
        if (summary.receivedAt.getTime() < this.startedAt - CLOCK_SLACK_MS) continue;
        const sender = fromDomain(summary.from);
        // only the site's own mail: a code from another sender is never for this page
        if (sender === undefined || registrableDomain(sender) !== domain) continue;
        const message = await mail.read(summary.id);
        const step = extractMailStep(message.body, domain);
        if (step === undefined) continue;
        const key = step.kind === 'code' ? step.code : step.url;
        if (this.used.has(key)) continue;
        this.used.add(key);
        return step;
      }
    } catch (error) {
      this.ctx.log.warn('browser: verification mail could not be read', {
        error: error instanceof Error ? error.name : 'error',
      });
    }
    return undefined;
  }
}

/** The helper for one task, or undefined when auto-auth is off or the start site is not on the list. */
export function authHelperFor(
  ctx: PluginContext,
  settings: AutoAuthSettings,
  texts: BrowserTexts,
  goal: string,
  startUrl: string | undefined,
): BrowserAuthHelper | undefined {
  if (!settings.enabled || settings.sites.length === 0 || startUrl === undefined) return undefined;
  const host = hostOf(startUrl);
  if (host === undefined) return undefined;
  const decision = decideAutoAuth({ pageUrl: startUrl, pageText: '', goal, sites: settings.sites, financialSites: [] });
  if (decision === 'not_allowed') return undefined;
  return new TaskAuthHelper(ctx, settings, texts, goal);
}
