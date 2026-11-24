import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { DocStore } from '../../core/contracts/docs.js';
import { renderDoc } from '../../core/docs/render.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { readCompanyConfig } from './config.js';
import type { ProfileSection, WorkTexts } from './locale-work.js';

const MAX_PROFILE_TEXT = 4000;
const MAX_FACTS = 10;
const MAX_DOC_ENTRIES = 10;

export interface ProfileDeps {
  /** Resolved at run time: the docs provider may start after this plugin. */
  docs: () => DocStore | undefined;
  texts: WorkTexts;
}

export interface ProfileQuestion {
  section: ProfileSection;
  question: string;
}

const QUESTIONS: Record<'ko' | 'en', readonly ProfileQuestion[]> = {
  ko: [
    { section: 'about', question: '회사를 한두 문장으로 소개해 주세요.' },
    { section: 'products', question: '주요 제품이나 서비스는 무엇인가요?' },
    { section: 'policies', question: '팀 봇이 꼭 지켜야 할 회사 규칙이 있나요? (예: 외부 발송은 대표 확인 후)' },
  ],
  en: [
    { section: 'about', question: 'Describe the company in one or two sentences.' },
    { section: 'products', question: 'What are the main products or services?' },
    { section: 'policies', question: 'Which company rules must the team bots always follow? (e.g. outside sending only after the owner checks)' },
  ],
};

/** Three short onboarding questions; their answers become company documents. */
export function profileQuestions(language: string): readonly ProfileQuestion[] {
  return language === 'en' ? QUESTIONS.en : QUESTIONS.ko;
}

const profileInput = z.object({
  section: z.enum(['about', 'products', 'policies']),
  text: z.string().min(1).max(MAX_PROFILE_TEXT),
  basedOnFacts: z.array(z.string().min(1)).max(MAX_FACTS).optional(),
});

export type CompanyProfileInput = z.infer<typeof profileInput>;

export interface CompanyProfileOutput {
  id: string;
  message: string;
}

export function companyProfileTool(deps: ProfileDeps): Tool<CompanyProfileInput, CompanyProfileOutput> {
  return {
    name: 'company.profile',
    description:
      "Save the company document for one section (about, products, policies); the text replaces the section. " +
      'Write it as a clean third-person document from what the owner said, keeping what the section already had ' +
      '(read it with company.docs first) and naming people with their role. Facts only from the owner.',
    input: profileInput,
    effects: ['write'],
    async run(value) {
      const docs = deps.docs();
      if (docs === undefined) throw new Error('docs_unavailable');
      const id = `company:${value.section}`;
      const text = value.text.trim();
      await docs.upsert({
        id,
        kind: 'company',
        scope: 'company',
        title: deps.texts.sectionTitle(value.section),
        body: text,
        // the model wrote it from what the owner said: recorded as the assistant's, so an owner edit is told apart
        author: { kind: 'agent', id: 'assistant' },
        ...(value.basedOnFacts !== undefined ? { basedOnFacts: value.basedOnFacts } : {}),
      });
      return { id, message: deps.texts.profileSaved(value.section) };
    },
  };
}

const docsInput = z.object({
  id: z.string().min(1).max(120).optional().describe('Document id from the list; omit to list company and team docs.'),
});

export type CompanyDocsInput = z.infer<typeof docsInput>;

export interface CompanyDocsOutput {
  message: string;
  docs?: { id: string; title: string; needsReview: boolean }[];
}

export function companyDocsTool(deps: ProfileDeps): Tool<CompanyDocsInput, CompanyDocsOutput> {
  return {
    name: 'company.docs',
    description: 'List company and team documents, or read one by id.',
    input: docsInput,
    effects: ['read'],
    async run(value) {
      const docs = deps.docs();
      if (docs === undefined) throw new Error('docs_unavailable');
      if (value.id !== undefined) {
        const doc = await docs.get(value.id);
        if (doc === undefined) return { message: deps.texts.docMissing };
        return { message: renderDoc(doc, { maxEntries: MAX_DOC_ENTRIES, reviewLabel: deps.texts.reviewLabel }) };
      }
      const listed = (await docs.list()).filter((doc) => doc.kind === 'company' || doc.kind === 'team');
      const views = listed.map((doc) => ({ id: doc.id, title: doc.title, needsReview: doc.needsReview }));
      return {
        message: views.length === 0 ? deps.texts.noDocs : listed.map((doc) => deps.texts.docsLine(doc)).join('\n'),
        docs: views,
      };
    },
  };
}

/** On first start with teams but no company profile, the owner gets one notice listing the questions. */
export async function onboardingNotice(
  ctx: PluginContext,
  docs: DocStore,
  texts: WorkTexts,
): Promise<void> {
  if ((await docs.get('company:about')) !== undefined) return;
  if (readCompanyConfig(ctx).teams.length === 0) return;
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) return;
  const questions = profileQuestions(texts.language).map((item) => item.question);
  await notifier.notify({
    kind: 'company.onboarding',
    dedupeKey: 'profile',
    text: texts.onboarding(questions),
  });
}
