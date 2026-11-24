import type { BrowserAction, PageElement } from './types.js';

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'combobox', 'listbox', 'option', 'spinbutton', 'slider', 'gridcell', 'row',
]);
const LINE = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;
const SECRET_NAME =
  /password|passcode|비밀번호|암호|\bpin\b|카드\s*번호|card\s*number|\bcvc\b|\bcvv\b|security code|유효\s*기간|주민(?:등록)?\s*번호|외국인\s*등록|계좌\s*번호|보안\s*카드|OTP|인증\s*번호/i;

/**
 * Interactive elements from a Playwright aria snapshot (`locator.ariaSnapshot()`), in page order, numbered as refs.
 * Duplicate role + name pairs get an `nth` so the driver clicks the one the model chose.
 */
export function parseAriaElements(snapshot: string, max = 150): PageElement[] {
  const out: PageElement[] = [];
  const seen = new Map<string, number>();
  for (const line of snapshot.split('\n')) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const role = match[1] ?? '';
    if (!INTERACTIVE.has(role)) continue;
    const name = (match[2] ?? '').replace(/\\(["\\])/g, '$1');
    const rest = match[3] ?? '';
    const key = `${role}\u0000${name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    out.push({
      ref: out.length,
      role,
      name,
      disabled: /\[disabled\]/.test(rest),
      secret: SECRET_NAME.test(name),
      nth,
    });
    if (out.length >= max) break;
  }
  return out;
}

export type Resolved = { ok: true; element?: PageElement } | { ok: false; error: string };

/** Binds an element action to the snapshot the model saw. Anything not in it is refused. */
export function resolveAction(action: BrowserAction, elements: readonly PageElement[]): Resolved {
  if (action.kind !== 'click' && action.kind !== 'fill' && action.kind !== 'select') return { ok: true };
  const element = elements[action.ref];
  if (element === undefined) return { ok: false, error: `ref ${action.ref} is not in the elements list; pick a listed ref` };
  if (element.disabled) return { ok: false, error: `ref ${action.ref} (${element.role} "${element.name}") is disabled` };
  if (action.kind === 'fill' && !['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(element.role)) {
    return { ok: false, error: `ref ${action.ref} is a ${element.role}, not a text field` };
  }
  return { ok: true, element };
}

/** Elements as the model sees them: one compact line each. */
export function renderElements(elements: readonly PageElement[]): string {
  return elements
    .map((e) => `[${e.ref}] ${e.role} "${e.name}"${e.disabled ? ' (disabled)' : ''}${e.secret ? ' (owner only)' : ''}`)
    .join('\n');
}
