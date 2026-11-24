import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { WebAgent, WebRunResult } from '../../core/contracts/web-agent.js';
import type { Effect } from '../../core/policy/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import { guardText } from '../../core/text/data.js';
import type { Tool } from '../../core/tools/types.js';
import type { WaysStore } from './store.js';
import { hostOf } from './store.js';

/** Words that mean money changes hands: the card then says "결제" and the agent still stops before paying. */
const BUYING = /주문|구매|결제|예매|예약|송금|이체|장바구니|구독|buy|order|purchase|pay|checkout|book|subscribe|transfer/i;
const SENDING = /보내|전송|발송|게시|올려|등록|제출|답장|댓글|send|post|publish|submit|reply|upload|share/i;

export interface WaysDeps {
  store: WaysStore;
  agent: () => WebAgent | undefined;
  clock: Clock;
  korean: boolean;
}

function explain(result: WebRunResult, korean: boolean): string | undefined {
  if (result.stopped === 'login') return korean ? '이 사이트에 로그인이 필요해요. Aside 브라우저에서 한 번 로그인해 두면 다음부터 할 수 있어요.' : 'This site needs a login in the Aside browser first.';
  if (result.stopped === 'payment') return korean ? '결제 바로 전에서 멈췄어요. 장바구니와 금액을 확인하고 결제는 직접 해 주세요.' : 'Stopped right before paying; the owner pays.';
  if (result.stopped === 'timeout') return korean ? '시간이 오래 걸려서 멈췄어요. 더 작게 나눠서 다시 해 볼게요.' : 'Timed out.';
  if (result.stopped === 'error') return korean ? '브라우저 작업이 실패했어요.' : 'The browser task failed.';
  return undefined;
}

const lookInput = z.object({
  task: z.string().min(3).max(800).describe('What to find out, in plain words.'),
  site: z.string().max(200).optional().describe('Site or URL, when known (a known company tool, a shop).'),
});
const doInput = lookInput.extend({ task: z.string().min(3).max(800).describe('The exact action, with every detail the owner gave (what, how many, to whom).') });

async function runWeb(deps: WaysDeps, mode: 'look' | 'do', value: z.infer<typeof lookInput>): Promise<Record<string, unknown>> {
  const agent = deps.agent();
  if (agent === undefined) {
    // the app alone is not enough: the assistant drives it through Aside's command-line tool
    const app = existsSync('/Applications/Aside.app') || existsSync(join(homedir(), 'Applications', 'Aside.app'));
    const ko = app
      ? 'Aside 앱은 있는데, 비서가 Aside를 움직이는 명령 도구가 아직 없어요. 비서 맥에서 `ax-kit setup`의 Google·Aside 단계를 다시 하면 설치돼요. 그동안 웹 검색(web.search)으로 찾아볼 수 있어요.'
      : '이 맥에 Aside(브라우저)가 없어요. 그동안 웹 검색(web.search)으로 찾아볼 수 있어요.';
    throw new Error(deps.korean ? ko : app ? 'Aside is installed but its command-line tool is not; re-run the Google/Aside step of `ax-kit setup`. web.search still works.' : 'No web agent (Aside) on this Mac; web.search still works.');
  }
  const host = value.site !== undefined ? (hostOf(value.site) ?? value.site) : hostOf(value.task);
  const result = await agent.run({ task: value.task, mode, ...(host !== undefined ? { site: host } : {}) });
  const now = deps.clock.now();
  if (host !== undefined) await deps.store.touchSite(host, now);
  // what worked once is the starting point next time
  if (result.ok) await deps.store.recordProcedure({ goal: value.task, ...(host !== undefined ? { site: host } : {}), how: result.answer.slice(0, 400) }, now);
  const note = explain(result, deps.korean);
  return { ok: result.ok, answer: guardText('web_answer', result.answer), ...(note !== undefined ? { note } : {}), ...(host !== undefined ? { site: host } : {}) };
}

export function wayTools(deps: WaysDeps): Tool[] {
  const look: Tool<z.infer<typeof lookInput>, Record<string, unknown>> = {
    name: 'web.look',
    description: "Look something up on the web or on a site the owner is signed in to (their company tools, shops, portals), in the owner's own browser. Changes nothing.",
    input: lookInput,
    effects: ['read'],
    timeoutMs: 12 * 60_000,
    describe: (value) => `웹에서 보기: ${value.task}${value.site !== undefined ? ` (${value.site})` : ''}`,
    run: async (value) => await runWeb(deps, 'look', value),
  };
  const act: Tool<z.infer<typeof doInput>, Record<string, unknown>> = {
    name: 'web.do',
    description: 'Do one action on a website in the owner\'s own browser (fill and submit a form, change a setting in a company tool, put items in a cart). The owner approves the exact task first; it never pays.',
    input: doInput,
    effects: ['write'],
    effectsFor: (value): readonly Effect[] => [...(SENDING.test(value.task) ? (['send'] as const) : []), ...(BUYING.test(value.task) ? (['pay'] as const) : []), 'send'],
    timeoutMs: 32 * 60_000,
    describe: (value) => `웹에서 하기: ${value.task}${value.site !== undefined ? ` (${value.site})` : ''}`,
    run: async (value) => await runWeb(deps, 'do', value),
  };
  const remember: Tool<{ site: string; label: string; what: string }, { host: string }> = {
    name: 'ways.remember_site',
    description: 'Remember a site the owner uses and what it is for (e.g. their company admin tool), so you use it later without asking.',
    input: z.object({ site: z.string().min(3).max(200), label: z.string().min(1).max(60), what: z.string().min(1).max(300) }),
    effects: ['write'],
    describe: (value) => `사이트 기억: ${value.site} — ${value.what}`,
    async run(value) {
      const host = hostOf(value.site) ?? value.site.toLowerCase();
      await deps.store.rememberSite({ host, label: value.label, what: value.what }, deps.clock.now());
      return { host };
    },
  };
  const forget: Tool<{ site: string }, { forgot: boolean }> = {
    name: 'ways.forget_site',
    description: 'Forget a remembered site.',
    input: z.object({ site: z.string().min(3).max(200) }),
    effects: ['write'],
    describe: (value) => `사이트 잊기: ${value.site}`,
    run: async (value) => ({ forgot: await deps.store.forgetSite(hostOf(value.site) ?? value.site.toLowerCase()) }),
  };
  return [look, act, remember, forget] as Tool[];
}
