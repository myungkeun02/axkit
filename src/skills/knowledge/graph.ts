import type { Doc, DocStore } from '../../core/contracts/docs.js';
import type { AppView } from '../../core/contracts/device-api.js';
import type { KnowledgeBuilder } from './builder.js';
import type { KnowledgeTexts } from './locale.js';
import type { KnowledgeStore, StoredLine } from './store.js';
import { docOf } from './tools.js';

/**
 * View "docgraph" (R4): the owner's documents as points and links, for the app's universe screen, and as layers for
 * its list. Links are found by code, never by a model: the owner's profile at the centre of their areas and projects,
 * documents that cite the same source, a document whose title another mentions, and team docs inside their company.
 */
interface Node {
  id: string;
  title: string;
  layer: string;
  group?: string;
  summary?: string;
  updatedAt?: string;
  weight: number;
}

interface Link {
  from: string;
  to: string;
  label?: string;
}

interface Source {
  node: Omit<Node, 'weight'>;
  text: string;
  sources: Set<string>;
  markdown: () => string | undefined;
}

const LABELS = {
  ko: { profile: '나', area: '생활 영역', project: '프로젝트', company: '회사', team: '팀', decision: '결정', meeting: '회의', other: '기타', same: '같은 자료', mention: '언급', mine: '나의', inside: '소속' },
  en: { profile: 'Me', area: 'Areas', project: 'Projects', company: 'Company', team: 'Teams', decision: 'Decisions', meeting: 'Meetings', other: 'Other', same: 'same source', mention: 'mentions', mine: 'mine', inside: 'part of' },
} as const;

/** A source cited by more than this many documents is too common to say they are related (a whole Drive). */
const MAX_SHARED = 5;
const MAX_NODES = 400;

function titleOf(name: string): string {
  return (name.split('/').at(-1) ?? name).replace(/\.md$/, '');
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function layerOfDoc(doc: Doc): string {
  if (doc.kind === 'company') return 'company';
  if (doc.kind === 'team') return 'team';
  if (doc.kind === 'decision') return 'decision';
  if (doc.kind === 'meeting') return 'meeting';
  return 'other';
}

export interface DocGraphDeps {
  store: KnowledgeStore;
  builder: KnowledgeBuilder;
  texts: KnowledgeTexts;
  language: string;
  docs?: DocStore;
}

async function collect(deps: DocGraphDeps): Promise<Source[]> {
  const byDoc = new Map<string, StoredLine[]>();
  for (const line of deps.store.visible()) {
    const name = docOf(line, deps.texts);
    byDoc.set(name, [...(byDoc.get(name) ?? []), line]);
  }
  const out: Source[] = [];
  for (const [name, lines] of byDoc) {
    const first = lines[0];
    if (first === undefined) continue;
    const layer = first.area === 'profile' ? 'profile' : first.area === 'project' ? 'project' : 'area';
    const key = first.area === 'project' ? first.topic : first.area === 'profile' ? 'profile' : first.area;
    const latest = lines.map((line) => line.at).sort().at(-1);
    out.push({
      node: { id: `k:${name}`, title: titleOf(name), layer, summary: cut(lines.map((line) => line.text).join(' · '), 120), ...(latest !== undefined ? { updatedAt: latest } : {}) },
      text: lines.map((line) => line.text).join('\n'),
      sources: new Set(lines.flatMap((line) => line.sources).filter((source) => source !== 'memory')),
      markdown: () => deps.builder.document(key),
    });
  }
  for (const doc of deps.docs === undefined ? [] : await deps.docs.list().catch(() => [])) {
    const group = doc.scope.split(':')[0] === 'team' ? (doc.scope.split(':')[1] ?? doc.scope) : doc.scope;
    out.push({
      node: { id: `d:${doc.id}`, title: doc.title, layer: layerOfDoc(doc), group, summary: cut(doc.body, 120), updatedAt: doc.updatedAt },
      text: `${doc.body}\n${doc.entries.map((entry) => entry.text).join('\n')}`,
      sources: new Set(doc.entries.flatMap((entry) => entry.sources)),
      markdown: () => [`# ${doc.title}`, '', doc.body, ...doc.entries.map((entry) => `- ${entry.at.slice(0, 10)} ${entry.text}`)].join('\n'),
    });
  }
  return out.slice(0, MAX_NODES);
}

function linksOf(sources: readonly Source[], labels: (typeof LABELS)['ko' | 'en']): Link[] {
  const links = new Map<string, Link>();
  const add = (from: string, to: string, label: string): void => {
    if (from === to) return;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    if (!links.has(key)) links.set(key, { from, to, label });
  };
  const profile = sources.find((source) => source.node.layer === 'profile');
  for (const source of sources) {
    if (profile !== undefined && (source.node.layer === 'area' || source.node.layer === 'project')) add(profile.node.id, source.node.id, labels.mine);
    if (source.node.layer === 'team' || source.node.layer === 'decision') {
      const company = sources.find((other) => other.node.layer === 'company' && other.node.group === source.node.group)
        ?? sources.find((other) => other.node.layer === 'team' && other.node.group === source.node.group && other !== source);
      if (company !== undefined) add(company.node.id, source.node.id, labels.inside);
    }
  }
  const citing = new Map<string, string[]>();
  for (const source of sources) for (const cited of source.sources) citing.set(cited, [...(citing.get(cited) ?? []), source.node.id]);
  for (const ids of citing.values()) {
    if (ids.length < 2 || ids.length > MAX_SHARED) continue;
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) add(ids[i] ?? '', ids[j] ?? '', labels.same);
  }
  for (const source of sources) {
    const title = source.node.title.trim();
    if (title.length < 2) continue;
    for (const other of sources) if (other !== source && other.text.includes(title)) add(other.node.id, source.node.id, labels.mention);
  }
  return [...links.values()];
}

export function docGraphView(deps: DocGraphDeps): AppView {
  const labels = LABELS[deps.language === 'en' ? 'en' : 'ko'];
  return {
    name: 'docgraph',
    version: 1,
    async read(query) {
      const sources = await collect(deps);
      const links = linksOf(sources, labels);
      const doc = query.get('doc');
      if (doc !== null) {
        const found = sources.find((source) => source.node.id === doc);
        if (found === undefined) return { document: null };
        const related = links
          .filter((link) => link.from === doc || link.to === doc)
          .map((link) => (link.from === doc ? link.to : link.from))
          .map((id) => sources.find((source) => source.node.id === id))
          .filter((source): source is Source => source !== undefined)
          .map((source) => ({ id: source.node.id, title: source.node.title }));
        return {
          document: {
            id: found.node.id,
            title: found.node.title,
            layer: found.node.layer,
            markdown: found.markdown() ?? found.text,
            ...(found.node.updatedAt !== undefined ? { updatedAt: found.node.updatedAt } : {}),
            related,
          },
        };
      }
      const degree = new Map<string, number>();
      for (const link of links) for (const id of [link.from, link.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
      const layerIds = ['profile', 'area', 'project', 'company', 'team', 'decision', 'meeting', 'other'] as const;
      const used = new Set(sources.map((source) => source.node.layer));
      return {
        layers: layerIds.filter((id) => used.has(id)).map((id) => ({ id, label: labels[id] })),
        nodes: sources.map((source) => ({ ...source.node, weight: 1 + Math.min(3, Math.floor((degree.get(source.node.id) ?? 0) / 2)) })),
        links,
      };
    },
  };
}
