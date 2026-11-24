import type { PhoneSms } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { offerAction } from './actions.js';
import type { SmsReaderConfig } from './config.js';
import type { SmsReaderTexts } from './locale.js';
import { readByModel } from './model.js';
import { readByRules } from './rules.js';
import { checkSmishing } from './smishing.js';
import type { Extraction } from './types.js';

const SEEN_KEY = 'seen';
const MAX_SEEN = 300;

export interface ReaderDeps {
  ctx: PluginContext;
  texts: SmsReaderTexts;
  config: SmsReaderConfig;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

/**
 * 문자 읽기: each forwarded text is checked for smishing first, then read by code rules, then (only when the rules are
 * unsure) by one cheap masked model call. Messages are queued so the bridge never waits on a model, and a card the
 * owner has not answered yet never holds up the next message. The body is never logged.
 */
export class SmsReader {
  private queue: Promise<void> = Promise.resolve();
  private readonly asking = new Set<Promise<void>>();

  constructor(private readonly deps: ReaderDeps) {}

  /** For the bridge: rules only, no model, no side effects. */
  claim(sms: { from?: string; text: string }): 'notice' | 'smishing' | undefined {
    if (checkSmishing(sms.text, sms.from).suspicious) return 'smishing';
    return readByRules(sms.text, sms.from).status === 'sure' ? 'notice' : undefined;
  }

  enqueue(sms: PhoneSms): void {
    this.queue = this.queue
      .then(() => this.process(sms))
      .catch((error: unknown) => this.deps.ctx.log.warn('sms-reader: message failed', { error: errorName(error) }));
  }

  /** Resolves once queued messages and the cards they opened are done (tests, shutdown). */
  async idle(): Promise<void> {
    await this.queue;
    while (this.asking.size > 0) await Promise.all([...this.asking]);
  }

  async process(sms: PhoneSms): Promise<void> {
    if (sms.text.trim() === '' || !(await this.firstTime(sms.ref))) return;
    const verdict = checkSmishing(sms.text, sms.from);
    if (verdict.suspicious) {
      await this.warn(sms, verdict.reasons, verdict.hosts);
      return;
    }
    const found = await this.extract(sms);
    if (found === undefined || found.kind === 'other') return;
    const asked = offerAction(this.deps, found, sms)
      .catch((error: unknown) => this.deps.ctx.log.warn('sms-reader: action failed', { kind: found.kind, error: errorName(error) }))
      .finally(() => this.asking.delete(asked));
    this.asking.add(asked);
  }

  private async extract(sms: PhoneSms): Promise<Extraction | undefined> {
    const rules = readByRules(sms.text, sms.from);
    if (rules.status === 'sure') return rules.found;
    if (rules.status === 'none' || !this.deps.config.model) return undefined;
    return readByModel(this.deps.ctx, sms.text, this.deps.ctx.clock.now());
  }

  private async warn(sms: PhoneSms, reasons: Parameters<SmsReaderTexts['smishingNotice']>[1], hosts: readonly string[]): Promise<void> {
    const notifier = this.deps.ctx.tryUse(Contracts.notifier);
    if (notifier === undefined) {
      this.deps.ctx.log.warn('sms-reader: smishing suspected but no notifier is available');
      return;
    }
    const sender = sms.from?.trim().slice(0, 40);
    await notifier.notify({
      kind: 'phone.smishing',
      dedupeKey: sms.ref,
      text: this.deps.texts.smishingNotice(sender === '' ? undefined : sender, reasons, hosts),
    });
  }

  private async firstTime(ref: string): Promise<boolean> {
    const stored = await this.deps.ctx.kv.get<string[]>(SEEN_KEY);
    const seen = Array.isArray(stored) ? stored : [];
    if (seen.includes(ref)) return false;
    await this.deps.ctx.kv.set(SEEN_KEY, [...seen, ref].slice(-MAX_SEEN));
    return true;
  }
}
