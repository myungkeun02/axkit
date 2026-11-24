import type { MailLabel, MailOrganizer, MailSummary } from '../../core/contracts/mail.js';
import { MAIL_ORGANIZE_MAX, MailPermissionError, ORGANIZE_SYSTEM_LABELS } from '../../core/contracts/mail.js';
import { GoogleApiError } from './errors.js';
import { toSummary } from './gmail.js';
import type { RawMessage } from './gmail.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';
import { GOOGLE_GMAIL_MODIFY_SCOPE } from './oauth.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ALLOWED_SYSTEM = new Set(ORGANIZE_SYSTEM_LABELS);

export interface GmailOrganizerOptions {
  request: GoogleRequestFn;
}

function toLabel(raw: unknown): MailLabel | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '' || typeof raw.name !== 'string') return undefined;
  return { id: raw.id, name: raw.name, system: raw.type === 'system' };
}

function checkIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.filter((id) => id.trim() !== ''))];
  if (unique.length > MAIL_ORGANIZE_MAX) throw new Error(`At most ${MAIL_ORGANIZE_MAX} mails at a time.`);
  return unique;
}

/**
 * Archives mail and changes labels through users.messages.batchModify. It never trashes or deletes: the only system
 * labels it touches are INBOX, UNREAD, STARRED and IMPORTANT. Needs the opt-in gmail.modify scope.
 */
export class GmailOrganizer implements MailOrganizer {
  constructor(private readonly deps: GmailOrganizerOptions) {}

  async labels(): Promise<MailLabel[]> {
    const listed = await this.call(() => this.deps.request<{ labels?: unknown[] }>(`${GMAIL_BASE}/labels`));
    return (listed.labels ?? []).flatMap((raw) => {
      const label = toLabel(raw);
      return label === undefined ? [] : [label];
    });
  }

  async peek(ids: readonly string[]): Promise<MailSummary[]> {
    const found: MailSummary[] = [];
    for (const id of checkIds(ids)) {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const name of ['From', 'Subject', 'Date']) params.append('metadataHeaders', name);
      let raw: RawMessage;
      try {
        raw = await this.call(() =>
          this.deps.request<RawMessage>(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?${params.toString()}`),
        );
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) continue;
        throw error;
      }
      const summary = toSummary(raw);
      if (summary !== undefined) found.push(summary);
    }
    return found;
  }

  async archive(ids: readonly string[]): Promise<void> {
    await this.modify(ids, [], ['INBOX']);
  }

  async addLabels(ids: readonly string[], labelNames: readonly string[]): Promise<void> {
    await this.modify(ids, await this.resolve(labelNames), []);
  }

  async removeLabels(ids: readonly string[], labelNames: readonly string[]): Promise<void> {
    await this.modify(ids, [], await this.resolve(labelNames));
  }

  async createLabel(name: string): Promise<MailLabel> {
    const wanted = name.trim();
    if (wanted === '') throw new Error('A label needs a name.');
    const existing = await this.find(wanted);
    if (existing !== undefined) return existing;
    try {
      const created = await this.call(() =>
        this.deps.request<unknown>(`${GMAIL_BASE}/labels`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: wanted, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
        }),
      );
      const label = toLabel(created);
      if (label === undefined) throw new Error('Gmail did not return the created label.');
      return label;
    } catch (error) {
      // made in the meantime (another device): use that one
      if (error instanceof GoogleApiError && error.status === 409) {
        const again = await this.find(wanted);
        if (again !== undefined) return again;
      }
      throw error;
    }
  }

  private async find(name: string): Promise<MailLabel | undefined> {
    const lower = name.toLowerCase();
    return (await this.labels()).find((label) => label.name.toLowerCase() === lower);
  }

  private async resolve(labelNames: readonly string[]): Promise<string[]> {
    const all = await this.labels();
    const ids: string[] = [];
    for (const name of labelNames) {
      const lower = name.trim().toLowerCase();
      const label = all.find((candidate) => candidate.name.toLowerCase() === lower || candidate.id.toLowerCase() === lower);
      if (label === undefined) throw new Error(`Gmail label not found: ${name}`);
      if (label.system && !ALLOWED_SYSTEM.has(label.id)) throw new Error(`Gmail label ${label.id} cannot be changed here.`);
      if (!ids.includes(label.id)) ids.push(label.id);
    }
    return ids;
  }

  private async modify(ids: readonly string[], add: readonly string[], remove: readonly string[]): Promise<void> {
    const targets = checkIds(ids);
    if (targets.length === 0 || (add.length === 0 && remove.length === 0)) return;
    for (const id of [...add, ...remove]) {
      // last line of defence: whatever the caller asked, mail never goes to trash or spam from here
      if (id === 'TRASH' || id === 'SPAM') throw new Error('Moving mail to trash or spam is not allowed.');
    }
    await this.call(() =>
      this.deps.request<unknown>(`${GMAIL_BASE}/messages/batchModify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ids: targets,
          ...(add.length > 0 ? { addLabelIds: add } : {}),
          ...(remove.length > 0 ? { removeLabelIds: remove } : {}),
        }),
      }),
    );
  }

  /** A sign-in without gmail.modify gets a 403; the skill turns that into "run ax-kit connect google again". */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GoogleApiError && error.insufficientScope) throw new MailPermissionError(GOOGLE_GMAIL_MODIFY_SCOPE);
      throw error;
    }
  }
}
