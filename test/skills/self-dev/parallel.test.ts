import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeProcessRunner } from '../../../src/core/process/node-runner.js';
import type { Coder, CoderInput } from '../../../src/skills/dev-assist/coder.js';
import { runSelfDev } from '../../../src/skills/self-dev/job.js';
import { ParallelSessions, createLock } from '../../../src/skills/self-dev/parallel.js';
import { PLAN_FILE, parsePlan } from '../../../src/skills/self-dev/plan.js';
import { MapKeyValueStore } from '../../core/helpers.js';

async function repo(): Promise<{ root: string; work: string }> {
  const base = await mkdtemp(join(tmpdir(), 'axk-par-'));
  const root = join(base, 'ax-kit');
  await mkdir(root);
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root });
  sh('init', '-q', '-b', 'main');
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(root, name), 'one\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return { root, work: join(base, 'work') };
}

const plan = JSON.stringify({
  pieces: [
    { title: 'B 고치기', brief: 'b.txt를 two로', files: ['b.txt'] },
    { title: 'C 고치기', brief: 'c.txt를 two로', files: ['c.txt'] },
  ],
});

/** The lead writes a.txt and the plan; each part's coder writes its own file (or fails when told to). */
function team(opts: { failC?: boolean; calls?: string[] } = {}): Coder {
  return {
    write: async ({ dir, instructions }: CoderInput) => {
      const who = /<part title="([^"]+)">/.exec(instructions)?.[1] ?? 'lead';
      opts.calls?.push(who);
      if (who === 'B 고치기' && !instructions.includes('could not finish')) await writeFile(join(dir, 'b.txt'), instructions.includes('<message>') ? 'three\n' : 'two\n');
      else if (who === 'C 고치기' && !instructions.includes('could not finish')) {
        if (opts.failC === true) return { ok: false, log: 'C 실패' };
        await writeFile(join(dir, 'c.txt'), 'two\n');
      } else if (instructions.includes('could not finish')) await writeFile(join(dir, 'c.txt'), 'lead did it\n');
      else {
        await writeFile(join(dir, 'a.txt'), 'two\n');
        if (instructions.includes(PLAN_FILE)) await writeFile(join(dir, PLAN_FILE), plan);
      }
      return { ok: true, log: `요약: ${who} 했어요\n사람이 할 일: 없음` };
    },
  };
}

function sessions(root: string, work: string, coder: Coder, posts: { room: string; text: string }[]) {
  return new ParallelSessions({ root, workDir: work, run: nodeProcessRunner, kv: new MapKeyValueStore(), directory: undefined, post: (room, text) => void posts.push({ room, text }), coder, checks: [['true']], checkLock: createLock(), group: 'assistant-admin' });
}

describe('parallel sessions in the ax 개선 room', () => {
  it('splits like a lead: parts run in their own rooms and branches, notes reach the lead, all is merged and applied', async () => {
    const { root, work } = await repo();
    const posts: { room: string; text: string }[] = [];
    const coder = team();
    const parallel = sessions(root, work, coder, posts);
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder, checks: [['true']], boot: false, parallel: (pieces, base) => parallel.start('ax-dev', '세 파일을 two로', pieces, base) }, 'sd-lead', '세 파일을 two로');
    expect(outcome.status).toBe('applied');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) expect(await readFile(join(root, name), 'utf8')).toBe('two\n');
    expect(execFileSync('git', ['ls-files'], { cwd: root }).toString()).not.toContain(PLAN_FILE);
    const lead = posts.filter((post) => post.room === 'ax-dev').map((post) => post.text);
    expect(lead[0]).toContain('하위 작업 2개');
    expect(lead.filter((text) => text.includes('끝났어요 ✓'))).toHaveLength(2);
    expect(new Set(posts.map((post) => post.room)).size).toBe(3);
    if (outcome.status === 'applied') expect(outcome.summary).toContain('B 고치기');
    await parallel.close(true);
    expect(execFileSync('git', ['branch', '--list', 'ax-self/*'], { cwd: root }).toString().trim()).toBe('');
  });

  it('does a part itself when that part’s session could not finish', async () => {
    const { root, work } = await repo();
    const posts: { room: string; text: string }[] = [];
    const coder = team({ failC: true });
    const parallel = sessions(root, work, coder, posts);
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder, checks: [['true']], boot: false, parallel: (pieces, base) => parallel.start('ax-dev', 'x', pieces, base) }, 'sd-lead2', 'x');
    expect(outcome.status).toBe('applied');
    expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('lead did it\n');
    expect(posts.some((post) => post.room === 'ax-dev' && post.text.includes("'C 고치기'] 끝내지 못했어요"))).toBe(true);
  });

  it('takes a follow-up in a part’s room before the lead goes on, and stops a part on "멈춰"', async () => {
    const { root, work } = await repo();
    const posts: { room: string; text: string }[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = team();
    const coder: Coder = { write: async (input) => (/<part title="C/.test(input.instructions) ? await gate.then(() => base.write(input)) : base.write(input)) };
    const parallel = sessions(root, work, coder, posts);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const pieces = parsePlan(plan);
    if (!pieces.ok) throw new Error('plan');
    const done = parallel.start('ax-dev', 'x', pieces.pieces, head);
    const rooms = (): string[] => [...new Set(posts.map((post) => post.room))].filter((room) => room !== 'ax-dev');
    // B is quick; while C still runs, the owner asks B for more and stops C
    for (let i = 0; i < 100 && !posts.some((post) => post.room === rooms()[0] && post.text.startsWith('끝났어요')); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const [roomB, roomC] = rooms();
    expect(await parallel.message(roomB ?? '', 'three로 바꿔줘')).toBe('이어서 반영할게요.');
    expect(await parallel.message(roomC ?? '', '멈춰')).toContain('멈췄어요');
    release();
    const outcomes = await done;
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['done', 'stopped']);
    const b = outcomes[0];
    if (b?.status === 'done') expect(execFileSync('git', ['show', `${b.branch}:b.txt`], { cwd: root }).toString()).toBe('three\n');
    await parallel.close(false);
    expect(await parallel.message(roomB ?? '', '더')).toContain('이미 합쳐서 끝났어요');
  });

  it('has the lead coder resolve a merge conflict with a part', async () => {
    const { root, work } = await repo();
    const posts: { room: string; text: string }[] = [];
    const base = team();
    const coder: Coder = {
      write: async (input) => {
        if (input.instructions.includes('conflict markers')) return await writeFile(join(input.dir, 'b.txt'), 'merged\n'), { ok: true, log: '요약: 합쳤어요' };
        const out = await base.write(input);
        if (!/<part title=/.test(input.instructions)) await writeFile(join(input.dir, 'b.txt'), 'lead\n');
        return out;
      },
    };
    const parallel = sessions(root, work, coder, posts);
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder, checks: [['true']], boot: false, progress: (text) => posts.push({ room: 'ax-dev', text }), parallel: (pieces, head) => parallel.start('ax-dev', 'x', pieces, head) }, 'sd-lead3', 'x');
    expect(outcome.status).toBe('applied');
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('merged\n');
    expect(posts.some((post) => post.text.includes('겹친 곳'))).toBe(true);
  });

  it('refuses a plan whose parts share a file', () => {
    expect(parsePlan(JSON.stringify({ pieces: [{ title: 'a', brief: 'x', files: ['src/a'] }, { title: 'b', brief: 'y', files: ['src/a/b.ts'] }] }))).toMatchObject({ ok: false });
    expect(parsePlan('nope')).toMatchObject({ ok: false });
    expect(parsePlan(JSON.stringify({ pieces: [] }))).toEqual({ ok: true, pieces: [] });
  });
});
