import { z } from 'zod';
import type { AppView } from '../../core/contracts/device-api.js';
import { ViewInputError } from '../../core/contracts/device-api.js';
import type { KnowledgeBuilder } from './builder.js';
import type { KnowledgeTexts } from './locale.js';
import type { KnowledgeStore } from './store.js';
import { docOf } from './tools.js';

const correctSchema = z.object({ lineId: z.string().min(1).max(200), text: z.string().max(2000).nullable() });

type DocKind = 'readme' | 'profile' | 'project' | 'area' | 'changelog';

function titleOf(name: string): string {
  return (name.split('/').at(-1) ?? name).replace(/\.md$/, '');
}

export interface KnowledgeViewDeps {
  store: KnowledgeStore;
  builder: KnowledgeBuilder;
  texts: KnowledgeTexts;
  /** The same queued path a chat review answer takes, so a fix from the app lands in the changelog too. */
  correct(lineId: string, text: string | undefined): Promise<void>;
  /** The changelog lives only as a file; without a documents folder there is none. */
  readChangelog?: () => Promise<string | undefined>;
}

interface DocRef {
  name: string;
  kind: DocKind;
  /** The builder's in-memory key for the rendered Markdown. */
  key: string;
}

/** View "knowledge" (docs/APP-PROTOCOL.md §5.3): the Markdown documents, their lines, and the owner's fixes. */
export function knowledgeView(deps: KnowledgeViewDeps): AppView {
  const linesOf = (name: string) =>
    deps.store.visible().filter((line) => docOf(line, deps.texts) === name).map((line) => ({
      id: line.id,
      topic: line.topic,
      text: line.text,
      sources: [...line.sources],
      origin: line.origin,
      at: line.at,
    }));

  // Document names are the Markdown file paths (as in knowledge.search), so links in README resolve the same way.
  const refs = (): DocRef[] => {
    const seen = new Map<string, DocRef>();
    const add = (ref: DocRef) => {
      if (!seen.has(ref.name)) seen.set(ref.name, ref);
    };
    add({ name: deps.texts.files.readme, kind: 'readme', key: 'README' });
    add({ name: deps.texts.files.profile, kind: 'profile', key: 'profile' });
    for (const line of deps.store.visible()) {
      const name = docOf(line, deps.texts);
      if (line.area === 'project') add({ name, kind: 'project', key: line.topic });
      else if (line.area !== 'profile') add({ name, kind: 'area', key: line.area });
    }
    if (deps.readChangelog !== undefined) add({ name: deps.texts.files.changelog, kind: 'changelog', key: '' });
    return [...seen.values()];
  };

  return {
    name: 'knowledge',
    version: 1,
    async read(query) {
      const doc = query.get('doc');
      if (doc === null) {
        return { documents: refs().map((ref) => ({ name: ref.name, title: titleOf(ref.name), kind: ref.kind, lines: linesOf(ref.name).length })) };
      }
      const ref = refs().find((candidate) => candidate.name === doc);
      const markdown = ref === undefined ? undefined
        : ref.kind === 'changelog' ? await deps.readChangelog?.()
        : deps.builder.document(ref.key);
      if (ref === undefined || markdown === undefined) return { document: null };
      return { document: { name: ref.name, title: titleOf(ref.name), kind: ref.kind, markdown, lines: linesOf(ref.name) } };
    },
    actions: {
      async correct(body) {
        const parsed = correctSchema.safeParse(body);
        if (!parsed.success || deps.store.get(parsed.data.lineId) === undefined) throw new ViewInputError('line');
        const text = parsed.data.text?.trim();
        await deps.correct(parsed.data.lineId, text === undefined || text === '' ? undefined : text);
        return { corrected: true };
      },
    },
  };
}
