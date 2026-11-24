import type { MailComposer, MailDraft, NewMailDraft } from '../../core/contracts/mail.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';
import { buildNewMime, encodeBase64Url } from './mime.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailComposerOptions {
  request: GoogleRequestFn;
}

/** Creates new drafts in the owner's mailbox. Sending stays with mail.send and an approval card. */
export class GmailComposer implements MailComposer {
  constructor(private readonly deps: GmailComposerOptions) {}

  async draftNew(draft: NewMailDraft): Promise<MailDraft> {
    const created = await this.deps.request<{ id?: unknown }>(`${GMAIL_BASE}/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { raw: encodeBase64Url(buildNewMime(draft)) } }),
    });
    if (!isRecord(created) || typeof created.id !== 'string' || created.id === '') {
      throw new Error('Gmail did not return the created draft.');
    }
    return { draftId: created.id, to: draft.to, cc: draft.cc ?? [], subject: draft.subject, body: draft.body };
  }
}
