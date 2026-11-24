import type { CandidateReport } from './candidates.js';
import { ymdOf } from '../../core/time/local-day.js';
import type { ExpensesTexts } from './locale.js';

export interface ClaimMail {
  subject: string;
  body: string;
  total: number;
  candidateCount: number;
}

export interface ClaimMailOptions {
  timeZone: string;
  companyLabel?: string;
  ownerName?: string;
  texts: ExpensesTexts;
}

/** Removes anything that looks like a card number; the card company name is what may stay. */
export function stripCardNumbers(text: string): string {
  return text
    .replace(/\d{4,}/g, ' ')
    .replace(/(?:\s*[-*xX]\s*){2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** "MM/DD" in the owner's time zone. */
export function shortDate(at: string, timeZone: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--/--';
  return ymdOf(date, timeZone).slice(5).replace('-', '/');
}

function safeText(value: string, fallback: string): string {
  const stripped = stripCardNumbers(value);
  return stripped === '' ? fallback : stripped;
}

/** Subject and plain-text body for a month's claim, candidates only. Never contains card numbers. */
export function buildClaimMail(report: CandidateReport, options: ClaimMailOptions): ClaimMail {
  const { texts } = options;
  const candidates = report.items.filter((item) => item.status === 'candidate');
  const lines = [texts.claimGreeting, ''];

  if (candidates.length === 0) {
    lines.push(texts.noCandidates);
  } else {
    for (const item of candidates) {
      const merchant = safeText(item.entry.merchant, texts.unknownMerchant);
      const rule = safeText(item.ruleName ?? texts.noRule, texts.noRule);
      lines.push(
        texts.claimLine(
          shortDate(item.entry.at, options.timeZone),
          merchant,
          texts.money(item.entry.amount, report.currency),
          rule,
        ),
      );
    }
    lines.push('');
    lines.push(texts.subtotalTitle);
    for (const total of report.totals) {
      lines.push(texts.subtotalLine(total.name ?? texts.noRule, total.count, texts.money(total.total, report.currency)));
    }
    lines.push(texts.grandTotal(texts.money(report.grandTotal, report.currency)));
    for (const total of report.totals) {
      if (!total.overCap || total.cap === undefined) continue;
      lines.push(
        texts.capLine(total.name ?? texts.noRule, texts.money(total.cap, report.currency), texts.money(total.total, report.currency)),
      );
    }
  }

  if (options.ownerName !== undefined && options.ownerName.trim() !== '') {
    lines.push('');
    lines.push(texts.signature(options.ownerName.trim()));
  }

  return {
    subject: texts.claimSubject(options.companyLabel, report.month),
    body: lines.join('\n').trimEnd(),
    total: report.grandTotal,
    candidateCount: candidates.length,
  };
}
