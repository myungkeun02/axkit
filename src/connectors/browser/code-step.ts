import type { BrowserAuthHelper } from '../../core/contracts/index.js';
import type { PlaywrightPage } from './playwright-agent.js';
import { isHttpUrl } from './url.js';

/** Inputs a one-time code usually goes into, most specific first. */
const CODE_INPUTS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="code" i]:not([type="hidden"])',
  'input[id*="code" i]:not([type="hidden"])',
  'input[inputmode="numeric"]',
] as const;

/**
 * Types a code (or opens a mailed link) when the page asks for one and the skill's helper hands one out. Returns the
 * codes used so the summary can mask them, or undefined when nothing was done.
 */
export async function completeCodeStep(
  page: PlaywrightPage,
  auth: BrowserAuthHelper,
  body: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  if (page.fill === undefined || page.$ === undefined) return undefined;
  const step = await auth.stepFor(page.url(), body, signal);
  if (step === undefined) return undefined;
  if (step.kind === 'link') {
    if (!isHttpUrl(step.url)) return undefined;
    await page.goto(step.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    return '';
  }
  for (const selector of CODE_INPUTS) {
    const found = await page.$(selector).catch(() => null);
    if (found === null || found === undefined) continue;
    await page.fill(selector, step.code);
    await page.press?.(selector, 'Enter');
    await page.waitForLoadState?.('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
    return step.code;
  }
  return undefined;
}
