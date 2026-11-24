import { z } from 'zod';
import type { Contact, ContactsReader } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import type { WorkspaceTexts } from './locale.js';
import { contactQuery } from './refs.js';

const searchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('A name as the owner said it ("김 대표님"), an email or a phone number.'),
  limit: z.number().int().min(1).max(10).default(5),
});

export type ContactsSearchInput = z.infer<typeof searchInput>;

export interface ContactsSearchOutput {
  contacts: Contact[];
  /** What was searched after honorifics and titles were taken off. */
  searched: string;
  message?: string;
  note: string;
}

/** People whose title or organization matches what the owner said come first; the rest keep Google's order. */
function rank(contacts: readonly Contact[], titles: readonly string[]): Contact[] {
  if (titles.length === 0) return [...contacts];
  const matches = (contact: Contact): boolean =>
    titles.some((title) => `${contact.title ?? ''} ${contact.organization ?? ''}`.toUpperCase().includes(title.toUpperCase()));
  return [...contacts.filter(matches), ...contacts.filter((contact) => !matches(contact))];
}

/** Tool "contacts.search": the owner's Google address book, read-only. */
export function contactsSearchTool(deps: { reader: ContactsReader; texts: WorkspaceTexts }): Tool<ContactsSearchInput, ContactsSearchOutput> {
  return {
    name: 'contacts.search',
    description:
      "Look up people in the owner's Google Contacts by name, email or phone to find an email address or number. " +
      'When several people match, ask the owner which one; never guess a recipient.',
    input: searchInput,
    effects: ['read'],
    async run(input, ctx) {
      const query = contactQuery(input.query);
      // Ask for a few more than shown so title ranking has people to choose from.
      const found = await deps.reader.search(query.term, Math.min(input.limit * 2, 20), ctx.signal);
      const contacts = rank(found, query.titles).slice(0, input.limit);
      return {
        contacts,
        searched: query.term,
        ...(contacts.length === 0 ? { message: deps.texts.noContacts } : {}),
        note: deps.texts.dataNote,
      };
    },
  };
}
