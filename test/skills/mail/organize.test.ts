import { describe, expect, it } from 'vitest';
import type {
  MailDraft,
  MailLabel,
  MailMessage,
  MailOrganizer,
  MailSummary,
} from '../../../src/core/contracts/index.js';
import { Contracts, MailPermissionError } from '../../../src/core/contracts/index.js';
import { mailSkill } from '../../../src/skills/mail/plugin.js';
import { organizeTexts } from '../../../src/skills/mail/organize-locale.js';
import { mailScope } from '../../../src/skills/mail/tools-organize.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const NOW = new Date('2026-11-19T09:00:00+09:00');

function summary(id: string, from: string, subject: string, labels: string[] = ['INBOX']): MailSummary {
  return { id, threadId: `t-${id}`, from, subject, snippet: '', receivedAt: NOW, unread: true, important: false, labels };
}

class FakeOrganizer implements MailOrganizer {
  mailbox: MailSummary[] = [];
  userLabels: MailLabel[] = [{ id: 'Label_1', name: '거래처', system: false }];
  readonly archived: string[][] = [];
  readonly added: [string[], string[]][] = [];
  readonly removed: [string[], string[]][] = [];
  readonly created: string[] = [];
  deny = false;

  private check(): void {
    if (this.deny) throw new MailPermissionError('https://www.googleapis.com/auth/gmail.modify');
  }
  async labels(): Promise<MailLabel[]> {
    this.check();
    return [{ id: 'INBOX', name: 'INBOX', system: true }, { id: 'TRASH', name: 'TRASH', system: true }, ...this.userLabels];
  }
  async peek(ids: readonly string[]): Promise<MailSummary[]> {
    this.check();
    return this.mailbox.filter((mail) => ids.includes(mail.id));
  }
  async archive(ids: readonly string[]): Promise<void> {
    this.check();
    this.archived.push([...ids]);
  }
  async addLabels(ids: readonly string[], names: readonly string[]): Promise<void> {
    this.added.push([[...ids], [...names]]);
  }
  async removeLabels(ids: readonly string[], names: readonly string[]): Promise<void> {
    this.removed.push([[...ids], [...names]]);
  }
  async createLabel(name: string): Promise<MailLabel> {
    this.created.push(name);
    const label = { id: `Label_${this.userLabels.length + 1}`, name, system: false };
    this.userLabels.push(label);
    return label;
  }
}

const unused = {
  search: async (): Promise<MailSummary[]> => [],
  read: async (): Promise<MailMessage> => {
    throw new Error('unused');
  },
  draftReply: async (): Promise<MailDraft> => {
    throw new Error('unused');
  },
  getDraft: async (): Promise<MailDraft> => {
    throw new Error('unused');
  },
  sendDraft: async () => ({ messageId: 'x' }),
};

async function setup(options: { organizer?: FakeOrganizer; confirmWrites?: boolean } = {}) {
  const confirmer = new FakeConfirmer('approved');
  const context = createTestContext({
    now: NOW,
    confirmer,
    policy: { confirmWrites: options.confirmWrites ?? false, expiresMinutes: 30 },
    capabilities: {
      [Contracts.mailRead.id]: unused,
      [Contracts.mailDraft.id]: unused,
      [Contracts.mailSend.id]: unused,
      ...(options.organizer !== undefined ? { [Contracts.mailOrganize.id]: options.organizer } : {}),
    },
  });
  await mailSkill().setup(context.ctx);
  const execute = (name: string, input: unknown) => context.ctx.tools.execute(name, input, { grounding: [] });
  return { ...context, confirmer, execute };
}

const SALE = { id: 'm1', from: 'Shop <ad@shop.example>', subject: '주말 세일', category: 'promotions' as const };

describe('mail organize tools without Gmail 정리', () => {
  it('registers the tools but refuses with how to grant the permission, before any card', async () => {
    const context = await setup({ confirmWrites: true });
    const names = context.ctx.tools.list().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['mail.labels', 'mail.archive', 'mail.label']));

    const outcome = await context.execute('mail.archive', { mails: [SALE] });
    expect(outcome.status).toBe('rejected');
    expect(outcome.status === 'rejected' ? outcome.reason : '').toContain('ax-kit connect google');
    expect(context.confirmer.requests).toHaveLength(0);

    const labels = await context.execute('mail.labels', {});
    expect(labels).toMatchObject({ status: 'failed' });
    expect(labels.status === 'failed' ? labels.error : '').toContain('Gmail 정리');
  });

  it('explains the missing scope when Google refuses at run time', async () => {
    const organizer = new FakeOrganizer();
    organizer.deny = true;
    const context = await setup({ organizer });
    const outcome = await context.execute('mail.archive', { mails: [SALE] });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toBe(organizeTexts('ko').needsPermission);
  });
});

describe('mail.archive', () => {
  it('shows subject and sender for up to five mails, then the rest as a count', async () => {
    const organizer = new FakeOrganizer();
    const mails = Array.from({ length: 7 }, (_, index) => ({ id: `m${index}`, from: `Shop <ad@shop.example>`, subject: `세일 ${index}` }));
    organizer.mailbox = mails.map((mail) => summary(mail.id, mail.from, mail.subject));
    const context = await setup({ organizer, confirmWrites: true });

    const outcome = await context.execute('mail.archive', { mails });
    expect(outcome).toEqual({ status: 'done', output: { archived: 7, gone: 0 } });
    const card = context.confirmer.requests[0]?.summary ?? '';
    expect(card).toContain('메일 7통 보관');
    expect(card).toContain('- Shop (ad@shop.example): 세일 0');
    expect(card).toContain('세일 4');
    expect(card).not.toContain('세일 5');
    expect(card).toContain('외 2통');
    expect(organizer.archived).toEqual([mails.map((mail) => mail.id)]);
  });

  it('caps a call at 50 mails', async () => {
    const context = await setup({ organizer: new FakeOrganizer() });
    const mails = Array.from({ length: 51 }, (_, index) => ({ id: `m${index}`, from: 'a@b.example', subject: 's' }));
    expect((await context.execute('mail.archive', { mails })).status).toBe('invalid_input');
  });

  it('touches nothing when a mail is not what the card said', async () => {
    const organizer = new FakeOrganizer();
    organizer.mailbox = [summary('m1', 'Boss <boss@company.example>', '계약서')];
    const context = await setup({ organizer });
    const outcome = await context.execute('mail.archive', { mails: [{ id: 'm1', from: 'ad@shop.example', subject: '계약서' }] });
    expect(outcome.status).toBe('failed');
    expect(organizer.archived).toHaveLength(0);
  });

  it('refuses a claimed category the mail does not have, and skips mails that are gone', async () => {
    const organizer = new FakeOrganizer();
    organizer.mailbox = [summary('m1', SALE.from, SALE.subject, ['INBOX'])];
    const context = await setup({ organizer });
    expect((await context.execute('mail.archive', { mails: [SALE] })).status).toBe('failed');

    organizer.mailbox = [summary('m1', SALE.from, SALE.subject, ['INBOX', 'CATEGORY_PROMOTIONS'])];
    const outcome = await context.execute('mail.archive', { mails: [SALE, { ...SALE, id: 'gone' }] });
    expect(outcome).toEqual({ status: 'done', output: { archived: 1, gone: 1 } });
  });
});

describe('mailScope', () => {
  const texts = organizeTexts('ko');
  it('prefers one Gmail category, then a company domain, then one sender, never everything', () => {
    expect(mailScope([SALE, { ...SALE, id: 'm2', from: 'x@other.example' }], texts)).toEqual({ key: 'category:promotions', who: '광고(프로모션)' });
    expect(mailScope([{ id: 'a', from: 'A <a@news.example>', subject: '' }, { id: 'b', from: 'b@news.example', subject: '' }], texts)?.key).toBe('domain:news.example');
    expect(mailScope([{ id: 'a', from: 'Mina <mina@gmail.com>', subject: '' }], texts)?.key).toBe('sender:mina@gmail.com');
    expect(mailScope([{ id: 'a', from: 'a@gmail.com', subject: '' }, { id: 'b', from: 'b@gmail.com', subject: '' }], texts)).toBeUndefined();
  });

  it('scopes "from now on" on the archive card to promotions', async () => {
    const context = await setup({ organizer: new FakeOrganizer() });
    const tool = context.registry.get('mail.archive');
    expect(tool?.autonomyScope?.({ mails: [SALE] })).toEqual({
      key: 'archive|category:promotions',
      label: '앞으로 광고(프로모션) 메일은 묻지 않고 보관할게요',
    });
  });
});

describe('mail.label', () => {
  it('creates a missing label, then adds and removes by name', async () => {
    const organizer = new FakeOrganizer();
    organizer.mailbox = [summary('m1', 'Mina <mina@client.example>', '견적')];
    const context = await setup({ organizer, confirmWrites: true });
    const outcome = await context.execute('mail.label', {
      mails: [{ id: 'm1', from: 'Mina <mina@client.example>', subject: '견적' }],
      add: ['거래처', '견적함'],
      remove: ['INBOX'],
    });
    expect(outcome).toEqual({ status: 'done', output: { changed: 1, gone: 0, created: ['견적함'] } });
    expect(organizer.created).toEqual(['견적함']);
    expect(organizer.added).toEqual([[['m1'], ['거래처', '견적함']]]);
    expect(organizer.removed).toEqual([[['m1'], ['INBOX']]]);
    const card = context.confirmer.requests[0]?.summary ?? '';
    expect(card).toContain('라벨 붙이기: 거래처, 견적함');
    expect(card).toContain('라벨 떼기: INBOX');
    expect(card).toContain('Mina (mina@client.example): 견적');
  });

  it('never moves mail to trash or spam, and needs something to change', async () => {
    const context = await setup({ organizer: new FakeOrganizer() });
    const mails = [{ id: 'm1', from: 'a@b.example', subject: 's' }];
    const trash = await context.execute('mail.label', { mails, add: ['TRASH'] });
    expect(trash.status === 'rejected' ? trash.reason : '').toContain('휴지통');
    expect((await context.execute('mail.label', { mails, add: ['spam'] })).status).toBe('rejected');
    expect((await context.execute('mail.label', { mails })).status).toBe('rejected');
  });

  it('says so when a label to remove does not exist', async () => {
    const organizer = new FakeOrganizer();
    organizer.mailbox = [summary('m1', 'a@b.example', 's')];
    const context = await setup({ organizer });
    const outcome = await context.execute('mail.label', { mails: [{ id: 'm1', from: 'a@b.example', subject: 's' }], remove: ['없음'] });
    expect(outcome.status === 'failed' ? outcome.error : '').toContain("'없음' 라벨이 메일함에 없어요");
    expect(organizer.removed).toHaveLength(0);
  });

  it('lists the owner labels and the usable system ones, not trash', async () => {
    const context = await setup({ organizer: new FakeOrganizer() });
    const outcome = await context.execute('mail.labels', {});
    expect(outcome).toEqual({
      status: 'done',
      output: [
        { name: 'INBOX', system: true },
        { name: '거래처', system: false },
      ],
    });
  });
});
