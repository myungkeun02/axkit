import { z } from 'zod';
import type { DocStore } from '../../core/contracts/docs.js';
import { renderDoc } from '../../core/docs/render.js';
import type { Tool } from '../../core/tools/types.js';
import type { DocsTexts } from './locale.js';

export interface DocsToolDeps {
  docs: () => DocStore | undefined;
  texts: DocsTexts;
}

const listInput = z.object({
  needsReview: z.boolean().optional().describe('Only documents whose facts changed and need the owner to check them.'),
  scope: z.string().max(60).optional().describe('"company", "team:<id>", "assistant".'),
});
const idInput = z.object({ id: z.string().min(1).max(120).describe('Document id from knowledge.docs.') });

export interface DocsListOutput {
  message: string;
  docs: { id: string; title: string; kind: string; needsReview: boolean; updatedAt: string }[];
}

export function docsListTool(deps: DocsToolDeps): Tool<z.infer<typeof listInput>, DocsListOutput> {
  return {
    name: 'knowledge.docs',
    description: 'List structured documents (team docs, decision records, change logs, company profile, improvement log).',
    input: listInput,
    effects: ['read'],
    async run(input) {
      const store = deps.docs();
      const docs = store === undefined ? [] : await store.list({
        ...(input.needsReview !== undefined ? { needsReview: input.needsReview } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      });
      const items = docs.slice(0, 50).map((doc) => ({
        id: doc.id,
        title: doc.title,
        kind: doc.kind,
        needsReview: doc.needsReview,
        updatedAt: doc.updatedAt,
      }));
      const review = items.filter((item) => item.needsReview).length;
      return { message: items.length === 0 ? deps.texts.none : deps.texts.listed(items.length, review), docs: items };
    },
  };
}

export function docsShowTool(deps: DocsToolDeps): Tool<z.infer<typeof idInput>, { message: string; text?: string }> {
  return {
    name: 'knowledge.doc_show',
    description: 'Show one document with its newest dated entries.',
    input: idInput,
    effects: ['read'],
    async run(input) {
      const doc = await deps.docs()?.get(input.id);
      if (doc === undefined) return { message: deps.texts.missing(input.id) };
      return { message: doc.title, text: renderDoc(doc, { maxEntries: 10, reviewLabel: deps.texts.reviewLabel }) };
    },
  };
}

/** The owner confirms a flagged document still matches reality; this clears the review flag. */
export function docsVerifyTool(deps: DocsToolDeps): Tool<z.infer<typeof idInput>, { message: string }> {
  return {
    name: 'knowledge.doc_verify',
    description: "Mark a document as still correct after the owner checked it. Only on the owner's own word.",
    input: idInput,
    effects: ['write'],
    describe: (input) => deps.texts.verifyDescription(input.id),
    async run(input) {
      const store = deps.docs();
      const doc = await store?.get(input.id);
      if (store === undefined || doc === undefined) return { message: deps.texts.missing(input.id) };
      await store.verify(doc.id);
      return { message: deps.texts.verified(doc.title) };
    },
  };
}
