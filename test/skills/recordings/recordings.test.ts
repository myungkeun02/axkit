import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { DriveWriter } from '../../../src/core/contracts/drive.js';
import type { LlmProvider } from '../../../src/core/llm/types.js';
import type { Plugin } from '../../../src/core/plugin/types.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { recordingsSkill } from '../../../src/skills/recordings/plugin.js';
import { api, events, pairApp, startApp, until } from '../../channels/app/harness.js';
import type { AppHarness } from '../../channels/app/harness.js';

const NOTES = {
  title: '결제 화면 회의',
  when: '11월 19일 오후',
  people: ['민수', '지수'],
  summary: '결제 내역을 엑셀로 내보내는 기능이 필요하다는 이야기를 했다.',
  decisions: ['다음 주까지 설계안'],
  todos: [{ who: '민수', what: '고객 요청 정리', due: '금요일' }],
  ideas: [{ key: 'payment-export', title: '결제 내역 내보내기', why: '고객이 매달 엑셀로 달라고 함', kind: 'dev' }],
};

function fakeModel(): LlmProvider & { purposes: string[] } {
  const purposes: string[] = [];
  return {
    id: 'fake',
    purposes,
    async complete(_model, request) {
      purposes.push(request.purpose);
      const text = request.purpose === 'recordings.notes'
        ? JSON.stringify(NOTES)
        : JSON.stringify({ reply: '설계안을 썼어요.', tool_calls: [], question: null });
      return { text, providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

function fakeDrive(saved: string[]): Plugin {
  const drive: DriveWriter = {
    async saveDocument(input) {
      saved.push(`${input.folderName}/${input.name}`);
      return { id: 'f1', url: 'https://docs.google.com/document/d/f1/edit' };
    },
  };
  return { manifest: { id: 'test.drive', kind: 'connector', title: 'drive' }, setup: (ctx) => ctx.provide(Contracts.driveWrite, drive) };
}

async function chunk(h: AppHarness, token: string, id: string, index: number, total: number, bytes: string): Promise<{ received: number; complete: boolean }> {
  const response = await fetch(`${h.base}/m/v1/app/recordings/${id}/chunks/${index}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'audio/mp4',
      'x-chunk-total': String(total),
      'x-started-at': '2026-11-19T05:00:00Z',
      'x-duration-sec': '1800',
    },
    body: bytes,
  });
  return (await response.json()) as { received: number; complete: boolean };
}

async function answerCard(h: AppHarness, token: string, topic: string, option: string): Promise<void> {
  await until(async () => (await events(h, token)).some((e) => e.type === 'card' && e.topic === topic));
  const card = (await events(h, token)).find((e) => e.type === 'card' && e.topic === topic);
  await api(h, token, `cards/${card?.type === 'card' ? card.cardId : ''}`, { option });
}

describe('recording → meeting notes → Drive → suggestion (R14)', () => {
  it('assembles resumable chunks, writes the notes, asks about Drive once and hands the idea to the dev bot', async () => {
    const heard: string[] = [];
    const saved: string[] = [];
    const model = fakeModel();
    const dir = join(await mkdtemp(join(tmpdir(), 'axkit-rec-')), 'recordings');
    const h = await startApp({
      llm: model,
      plugins: [
        assistantSkill({ loadSystemPrompt: async () => 'You are {{persona}}. {{tools}}' }),
        fakeDrive(saved),
        recordingsSkill({
          dir,
          transcriber: {
            transcribe: async (path) => {
              heard.push(path);
              return '민수: 결제 내역 엑셀로 달래요. 지수: 다음 주까지 설계해요.';
            },
          },
        }),
      ],
    });
    try {
      const { token } = await pairApp(h);
      const bots = h.app.host.capability(Contracts.bots)!;
      await bots.upsert({ id: 'dev', name: '개발 봇', role: '앱 코드', kind: 'dev', origin: 'owner' });
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).toContain('recordings');

      expect(await chunk(h, token, 'r_meet1', 1, 3, 'BB')).toEqual({ ok: true, received: 0, complete: false });
      expect(await chunk(h, token, 'r_meet1', 0, 3, 'AA')).toMatchObject({ received: 2, complete: false });
      expect(await chunk(h, token, 'r_meet1', 2, 3, 'CC')).toMatchObject({ received: 3, complete: true });
      expect((await fetch(`${h.base}/m/v1/app/recordings/BAD/chunks/0`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-chunk-total': '1' }, body: 'x' })).status).toBe(400);

      await answerCard(h, token, 'drive:save:meeting-notes', 'save');
      await answerCard(h, token, 'dev:suggest:payment-export', 'design');
      await until(async () => (await events(h, token)).some((e) => e.type === 'delegation' && e.state === 'done'));

      expect(heard).toHaveLength(1);
      expect(saved).toEqual(['ax-kit 회의록/결제 화면 회의']);
      const view = (await (await api(h, token, 'views/recordings')).json()) as { data: { recordings: Record<string, unknown>[] } };
      expect(view.data.recordings[0]).toMatchObject({ id: 'r_meet1', status: 'done', title: '결제 화면 회의', documentId: 'd:meeting:r_meet1', driveUrl: expect.stringContaining('docs.google.com') });
      const doc = await h.app.host.capability(Contracts.docs)!.get('meeting:r_meet1');
      expect(doc).toMatchObject({ kind: 'meeting', title: '결제 화면 회의', body: expect.stringContaining('## 정한 것') });
      const all = await events(h, token);
      expect(all.some((e) => e.type === 'notice' && e.text.includes('회의록을 정리했어요: 결제 화면 회의'))).toBe(true);
      expect(all.find((e) => e.type === 'delegation')).toMatchObject({ bot: { id: 'dev' }, task: expect.stringContaining('설계안만 먼저') });

      // a second meeting with the same idea: Drive is not asked again, the idea is not suggested again
      await chunk(h, token, 'r_meet2', 0, 1, 'DD');
      await until(async () => saved.length === 2);
      const cards = (await events(h, token)).filter((e) => e.type === 'card');
      expect(cards.map((c) => (c.type === 'card' ? c.topic : ''))).toEqual(['drive:save:meeting-notes', 'dev:suggest:payment-export']);
    } finally {
      await h.stop();
    }
  });

  it('keeps a webm recording as webm for the transcriber (D5)', async () => {
    const heard: string[] = [];
    const dir = join(await mkdtemp(join(tmpdir(), 'axkit-rec-')), 'recordings');
    const h = await startApp({ plugins: [recordingsSkill({ dir, transcriber: { transcribe: async (path) => (heard.push(path), '') } })] });
    try {
      const { token } = await pairApp(h);
      await fetch(`${h.base}/m/v1/app/recordings/r_web/chunks/0`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/webm;codecs=opus', 'x-chunk-total': '1' }, body: 'WEBM' });
      await until(() => heard.length === 1);
      expect(heard[0]).toMatch(/r_web\/audio\.webm$/);
    } finally {
      await h.stop();
    }
  });

  it('without a transcriber the recording is marked failed with a plain reason, once', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'axkit-rec-')), 'recordings');
    const h = await startApp({ plugins: [recordingsSkill({ dir, transcriber: null })] });
    try {
      const { token } = await pairApp(h);
      await chunk(h, token, 'r_x', 0, 1, 'AA');
      await until(async () => {
        const view = (await (await api(h, token, 'views/recordings')).json()) as { data: { recordings: { status: string }[] } };
        return view.data.recordings[0]?.status === 'failed';
      });
      const view = (await (await api(h, token, 'views/recordings')).json()) as { data: { recordings: { statusText: string }[] } };
      expect(view.data.recordings[0]?.statusText).toContain('받아쓰기');
      expect(await chunk(h, token, 'r_x', 0, 1, 'AA')).toMatchObject({ complete: true });
    } finally {
      await h.stop();
    }
  });
});
