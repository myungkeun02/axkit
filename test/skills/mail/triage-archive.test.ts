import { describe, expect, it } from 'vitest';
import type {
  MailDraft,
  MailLabel,
  MailMessage,
  MailOrganizer,
  MailSummary,
  Notice,
  Notifier,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { OwnerQuestions } from '../../../src/core/policy/questions.js';
import { SqliteTopicAnswers, TOPIC_MIGRATIONS } from '../../../src/core/policy/topics.js';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { mailSkill } from '../../../src/skills/mail/plugin.js';
import { archivable, mergeCandidates } from '../../../src/skills/mail/triage-archive.js';
import { readTriageConfig } from '../../../src/skills/mail/triage-config.js';
import { triageOnce } from '../../../src/skills/mail/triage-job.js';
import { createTestContext, FakeConfirmer, ScriptedLlm } from '../../support/context.js';

const NOW = new Date('2026-11-19T09:00:00+09:00');

function mail(id: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId: `t-${id}`,
    from: 'Mina Kim <mina@example.com>',
    to: ['owner@example.com'],
    cc: [],
    subject: '견적 회의',
    snippet: '',
    receivedAt: NOW,
    unread: true,
    important: false,
    labels: ['INBOX', 'UNREAD'],
    body: '견적서 확인 부탁드려요.',
    ...overrides,
  };
}

class FakeMailbox implements MailOrganizer {
  inbox: MailMessage[] = [];
  readonly archived: string[][] = [];
  async search(): Promise<MailSummary[]> {
    return [...this.inbox].reverse();
  }
  async read(id: string): Promise<MailMessage> {
    const found = this.inbox.find((message) => message.id === id);
    if (found === undefined) throw new Error(`no mail ${id}`);
    return found;
  }
  async draftReply(): Promise<MailDraft> {
    throw new Error('unused');
  }
  async getDraft(): Promise<MailDraft> {
    throw new Error('unused');
  }
  async sendDraft(): Promise<{ messageId: string }> {
    throw new Error('unused');
  }
  async labels(): Promise<MailLabel[]> {
    return [];
  }
  async peek(ids: readonly string[]): Promise<MailSummary[]> {
    return this.inbox.filter((message) => ids.includes(message.id));
  }
  async archive(ids: readonly string[]): Promise<void> {
    this.archived.push([...ids]);
  }
  async addLabels(): Promise<void> {}
  async removeLabels(): Promise<void> {}
  async createLabel(name: string): Promise<MailLabel> {
    return { id: name, name, system: false };
  }
}

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<'sent'> {
    this.notices.push(notice);
    return 'sent';
  }
}

function triageJson(importance: 'normal' | 'low'): string {
  return JSON.stringify({ importance, summary: '한 문장 요약이에요.', actions: [] });
}

async function setup(withOrganizer: boolean, script: string[]) {
  const box = new FakeMailbox();
  const notifier = new FakeNotifier();
  const confirmer = new FakeConfirmer('approved');
  const store = openSqliteStore(':memory:');
  await store.migrate(TOPIC_MIGRATIONS);
  const questions = new OwnerQuestions({ topics: new SqliteTopicAnswers(store.sql, () => NOW), confirmer: () => confirmer, now: () => NOW });
  const context = createTestContext({
    now: NOW,
    llm: new ScriptedLlm(script),
    confirmer,
    capabilities: {
      [Contracts.mailRead.id]: box,
      [Contracts.mailDraft.id]: box,
      [Contracts.mailSend.id]: box,
      [Contracts.notifier.id]: notifier,
      [Contracts.questions.id]: questions,
      ...(withOrganizer ? { [Contracts.mailOrganize.id]: box } : {}),
    },
  });
  await mailSkill().setup(context.ctx);
  const config = readTriageConfig(context.ctx);
  const run = () => triageOnce(context.ctx, config, context.clock.now());
  expect((await run()).status).toBe('seeded');
  return { ...context, box, notifier, confirmer, run };
}

function fill(box: FakeMailbox): void {
  box.inbox.push(
    mail('m1'),
    mail('ad1', { from: 'Shop News <newsletter@shop.example>', subject: '주말 세일' }),
    mail('up1', { from: 'Service <info@service.example>', subject: '이용 약관 안내', labels: ['INBOX', 'CATEGORY_UPDATES'] }),
    mail('bank', { from: 'Bank <no-reply@bank.example>', subject: '로그인 알림', labels: ['INBOX'] }),
  );
}

describe('mail triage archive offer', () => {
  it('asks once per digest to archive advertising-like mail and archives on a yes', async () => {
    const context = await setup(true, [triageJson('normal'), triageJson('low'), triageJson('low')]);
    fill(context.box);
    await context.clock.advance(3 * 3_600_000);

    await (await context.run()).followUps;

    const digest = context.notifier.notices.find((notice) => notice.kind === 'mail.digest');
    expect(digest?.text).toContain('광고·알림 메일 2통은 보관할지 따로 물어볼게요.');
    expect(context.confirmer.requests).toHaveLength(1);
    const card = context.confirmer.requests[0];
    expect(card?.topic).toMatch(/^mail:archive:[0-9a-z]+$/);
    expect(card?.summary).toBe('광고·알림 메일 2통을 보관할까요?');
    expect(card?.note).toContain('Shop News (newsletter@shop.example): 주말 세일');
    expect(card?.note).toContain('지워지지 않아요');
    // the no-reply bank notice and the normal mail are never offered
    expect(context.box.archived).toEqual([['ad1', 'up1']]);
    expect(context.notifier.notices.some((notice) => notice.text === '광고·알림 메일 2통을 보관했어요.')).toBe(true);
  });

  it('offers nothing without Gmail 정리', async () => {
    const context = await setup(false, [triageJson('normal'), triageJson('low'), triageJson('low')]);
    fill(context.box);
    await context.clock.advance(3 * 3_600_000);

    await (await context.run()).followUps;

    expect(context.notifier.notices.find((notice) => notice.kind === 'mail.digest')?.text).not.toContain('보관');
    expect(context.confirmer.requests).toHaveLength(0);
  });

  it('keeps important, starred and muted mail out, and caps the list at 50', () => {
    const ad = mail('a', { from: 'newsletter@shop.example' });
    expect(archivable(ad, [])).toBe(true);
    expect(archivable({ ...ad, important: true }, [])).toBe(false);
    expect(archivable({ ...ad, labels: ['INBOX', 'STARRED'] }, [])).toBe(false);
    expect(archivable(ad, ['@shop.example'])).toBe(false);
    expect(archivable(mail('u', { labels: ['CATEGORY_UPDATES'] }), [])).toBe(false);
    expect(archivable(mail('u', { labels: ['CATEGORY_UPDATES'] }), [], true)).toBe(true);

    const many = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, from: 'a@b.example', subject: 's' }));
    const merged = mergeCandidates(many.slice(0, 30), many.slice(25));
    expect(merged).toHaveLength(50);
    expect(merged.at(-1)?.id).toBe('m59');
  });
});
