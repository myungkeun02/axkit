import { describe, expect, it } from 'vitest';
import {
  intakeHandler,
  registerEventIntake,
  registerMailIntake,
  submitRequest,
  submitTool,
} from '../../../src/skills/company/intake.js';
import {
  companyConfig,
  FakeMail,
  mailSummary,
  makeReplier,
  message,
  MARKETING,
  NOW,
  setupIntake,
} from './helpers.js';

describe('submitRequest', () => {
  it('creates a queued task for owner work and classifies the team', async () => {
    const setup = setupIntake({ classify: async () => MARKETING });

    const result = await submitRequest(setup.deps, { request: '  광고 문구를 써 주세요  ', source: 'owner' });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.task).toMatchObject({
      team: 'marketing',
      title: '광고 문구를 써 주세요',
      request: '광고 문구를 써 주세요',
      source: 'owner',
      status: 'queued',
    });
  });

  it('keeps a mail request awaiting_accept with its sourceRef', async () => {
    const setup = setupIntake();

    const result = await submitRequest(setup.deps, {
      request: '버그 제보 메일',
      source: 'mail',
      sourceRef: 'mail:m1',
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.task).toMatchObject({
      team: 'dev',
      status: 'awaiting_accept',
      source: 'mail',
      sourceRef: 'mail:m1',
    });
  });

  it('refuses an unknown team and lists the team names', async () => {
    const setup = setupIntake();

    const result = await submitRequest(setup.deps, { request: '점심 메뉴 정해 주세요', source: 'owner' });

    expect(result).toEqual({
      status: 'refused',
      message: "어느 팀 일인지 모르겠어요. 팀: 개발, 마케팅 — '@dev 할 일'처럼 적어 주세요.",
    });
  });

  it('refuses when the company-wide cap is reached', async () => {
    const setup = setupIntake({ config: { limits: { ...companyConfig().limits, maxOpen: 1 } } });
    await setup.repo.create({ team: 'dev', title: '기존 일', request: '기존 일', source: 'owner', status: 'queued' });

    const result = await submitRequest(setup.deps, { request: '버그 고쳐 주세요', source: 'owner' });

    expect(result).toEqual({
      status: 'refused',
      message: '지금 회사 일이 1건 열려 있어 더 받지 않을게요. 끝나거나 닫히면 다시 맡겨 주세요.',
    });
  });

  it('refuses when the team cap is reached', async () => {
    const setup = setupIntake({ config: { limits: { ...companyConfig().limits, maxOpenPerTeam: 1 } } });
    await setup.repo.create({ team: 'dev', title: '기존 일', request: '기존 일', source: 'owner', status: 'queued' });

    const result = await submitRequest(setup.deps, { request: '버그 고쳐 주세요', source: 'owner' });

    expect(result).toEqual({ status: 'refused', message: '개발 팀은 이미 1건을 하고 있어요.' });
  });

  it('refuses a duplicate open sourceRef', async () => {
    const setup = setupIntake();
    await submitRequest(setup.deps, { request: '버그 제보', source: 'mail', sourceRef: 'mail:m1' });

    const result = await submitRequest(setup.deps, { request: '다시 버그 제보', source: 'mail', sourceRef: 'mail:m1' });

    expect(result).toEqual({ status: 'refused', message: '이미 맡긴 일이에요: 버그 제보' });
  });
});

describe('intakeHandler', () => {
  it('creates a queued task for an owner message and replies', async () => {
    const setup = setupIntake();
    const handler = intakeHandler(setup.deps);
    const { replier, replies } = makeReplier();

    const result = await handler.handle(message('회사: 버그를 고쳐 주세요'), replier);

    expect(result).toBe('handled');
    const [created] = await setup.repo.all();
    expect(created).toMatchObject({ team: 'dev', status: 'queued', source: 'owner' });
    expect(replies.map((reply) => reply.text)).toEqual(['맡겼어요 — 버그를 고쳐 주세요']);
  });

  it('passes for anyone but the owner and for ordinary messages', async () => {
    const setup = setupIntake();
    const handler = intakeHandler(setup.deps);
    const { replier, replies } = makeReplier();

    expect(await handler.handle(message('회사: 버그를 고쳐 주세요', false), replier)).toBe('pass');
    expect(await handler.handle(message('안녕하세요'), replier)).toBe('pass');
    expect(replies).toEqual([]);
    expect(await setup.repo.all()).toEqual([]);
  });

  it('replies with the refusal when the backlog is full', async () => {
    const setup = setupIntake({ config: { limits: { ...companyConfig().limits, maxOpen: 1 } } });
    await setup.repo.create({ team: 'dev', title: '기존 일', request: '기존 일', source: 'owner', status: 'queued' });
    const handler = intakeHandler(setup.deps);
    const { replier, replies } = makeReplier();

    await handler.handle(message('회사: 버그를 고쳐 주세요'), replier);

    expect(replies[0]?.text).toContain('지금 회사 일이 1건 열려 있어');
  });

  it('accepts an awaiting task with an owner write approval', async () => {
    const setup = setupIntake();
    const submitted = await submitRequest(setup.deps, { request: '버그 제보', source: 'mail', sourceRef: 'mail:m1' });
    if (submitted.status !== 'created') throw new Error('not created');
    const handler = intakeHandler(setup.deps);
    const { replier, replies } = makeReplier();

    const result = await handler.handle(message(`(choice: company.accept:${submitted.task.id})`), replier);

    expect(result).toBe('handled');
    const accepted = await setup.repo.get(submitted.task.id);
    expect(accepted?.status).toBe('queued');
    expect(accepted?.approvals).toEqual([
      { approverKind: 'user', approverId: 'owner', effects: ['write'], at: '2026-11-18T00:00:00.000Z' },
    ]);
    expect(replies[0]?.text).toBe('맡겼어요 — 버그 제보');
  });

  it('drops an awaiting task as declined', async () => {
    const setup = setupIntake();
    const submitted = await submitRequest(setup.deps, { request: '광고 메일', source: 'mail', sourceRef: 'mail:m2' });
    if (submitted.status !== 'created') throw new Error('not created');
    const handler = intakeHandler(setup.deps);
    const { replier, replies } = makeReplier();

    await handler.handle(message(`(choice: company.drop:${submitted.task.id})`), replier);

    const dropped = await setup.repo.get(submitted.task.id);
    expect(dropped?.status).toBe('closed');
    expect(dropped?.closedReason).toBe('declined');
    expect(dropped?.finishedAt).toBe('2026-11-18T00:00:00.000Z');
    expect(replies[0]?.text).toBe('닫을게요: 광고 메일');
  });

  it('answers politely for an unknown or already queued task', async () => {
    const setup = setupIntake();
    const queued = await setup.repo.create({
      team: 'dev',
      title: '이미 받은 일',
      request: '이미 받은 일',
      source: 'owner',
      status: 'queued',
    });
    const handler = intakeHandler(setup.deps);
    const { replier, replies } = makeReplier();

    await handler.handle(message('(choice: company.accept:deadbeef)'), replier);
    await handler.handle(message(`(choice: company.accept:${queued.id})`), replier);

    expect(replies.map((reply) => reply.text)).toEqual([
      '그 일을 찾지 못했어요. 이미 처리됐을 수 있어요.',
      '그 일을 찾지 못했어요. 이미 처리됐을 수 있어요.',
    ]);
  });
});

describe('submitTool', () => {
  it('registers as a write tool and submits owner work', async () => {
    const setup = setupIntake();
    const tool = submitTool(setup.deps);
    setup.ctx.registerTool(tool);

    const outcome = await setup.ctx.tools.execute('company.submit', { request: '버그를 고쳐 주세요' });

    expect(tool.name).toBe('company.submit');
    expect(tool.effects).toEqual(['write']);
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.output).toMatchObject({ status: 'created' });
  });
});

describe('registerEventIntake', () => {
  it('turns a company.intake event into an awaiting task', async () => {
    const setup = setupIntake();
    registerEventIntake(setup.deps);

    await setup.bus.emit('company.intake', { request: '버그 제보', ref: 'event-1' });

    const [created] = await setup.repo.all();
    expect(created).toMatchObject({
      team: 'dev',
      status: 'awaiting_accept',
      source: 'event',
      sourceRef: 'event-1',
    });
  });

  it('queues work the owner already approved on another card', async () => {
    const setup = setupIntake();
    registerEventIntake(setup.deps);

    await setup.bus.emit('company.intake', { request: '버그 제보 정리', ref: 'mail:m1', approvedByOwner: true });

    const [created] = await setup.repo.all();
    expect(created).toMatchObject({ status: 'queued', source: 'event', sourceRef: 'mail:m1' });
  });
});

describe('registerMailIntake', () => {
  it('seeds seen ids on the first run and creates only later unseen mail', async () => {
    const setup = setupIntake({
      config: { mailIntake: { enabled: true, query: 'work', everyMinutes: 30 } },
      classify: async () => undefined,
    });
    const mail = new FakeMail();
    mail.items = [mailSummary('m1', '버그 제보', '첫 메일', new Date('2026-11-17T09:00:00+09:00'))];
    registerMailIntake(setup.deps, () => mail);

    await setup.scheduler.run('company.mail-intake', new Date('2026-11-18T08:00:00+09:00'));

    expect(await setup.repo.all()).toEqual([]);
    expect(await setup.kv.get('mail:seen')).toEqual(['m1']);

    mail.items.push(mailSummary('m2', '버그 제보 2', '두 번째 메일', new Date('2026-11-18T08:30:00+09:00')));
    await setup.scheduler.run('company.mail-intake', new Date('2026-11-18T09:00:00+09:00'));

    const tasks = await setup.repo.all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: 'awaiting_accept',
      source: 'mail',
      sourceRef: 'mail:m2',
      request: '버그 제보 2\n두 번째 메일',
    });

    await setup.scheduler.run('company.mail-intake', new Date('2026-11-18T09:30:00+09:00'));

    expect(await setup.repo.all()).toHaveLength(1);
    expect(mail.queries.every((query) => query.text === 'work' && query.limit === 5)).toBe(true);
  });

  it('does nothing when mail intake is off or the query is empty', async () => {
    const setup = setupIntake({ config: { mailIntake: { enabled: false, query: '', everyMinutes: 30 } } });
    registerMailIntake(setup.deps, () => new FakeMail());

    await expect(setup.scheduler.run('company.mail-intake', NOW)).rejects.toThrow('No job company.mail-intake');
  });
});
