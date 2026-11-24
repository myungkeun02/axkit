import { z } from 'zod';
import type { Effect } from '../../core/policy/types.js';
import { evidenceFound } from '../../core/time/evidence.js';
import type { Tool, ToolCallContext } from '../../core/tools/types.js';
import type { MacAppsClient, TargetStep } from './client.js';
import { actRefusal, cardNote, categorize, effectsOfLabel, secureFieldRefusal } from './policy.js';
import { parseStep, resolveApp } from './resolve.js';

const ACTIONS = ['press', 'set', 'menu', 'activate'] as const;
const STEP_HINT = '"AXRole" or "AXRole[title]"';

const input = z.object({
  app: z.string().min(1).max(120).describe('Bundle id or exact name of a running app, as mac.apps shows it.'),
  action: z
    .enum(ACTIONS)
    .describe('press a button, set a text field, choose a menu item, or bring the app to the front (activate).'),
  target: z
    .array(z.string().min(2).max(200))
    .min(1)
    .max(6)
    .optional()
    .describe(
      `press/set: steps from the focused window down, each ${STEP_HINT} as mac.read_window shows them. ` +
        'Each step matches anything inside the previous one, e.g. ["AXSheet", "AXButton[저장]"]. More than one match is refused.',
    ),
  menu: z
    .array(z.string().min(1).max(100))
    .min(2)
    .max(6)
    .optional()
    .describe('menu: the menu bar path, e.g. ["파일", "새로운 메모"].'),
  value: z.string().max(5000).optional().describe('set: the text to put into the field.'),
  evidence: z
    .string()
    .min(2)
    .max(300)
    .describe("The owner's own words in this message that ask for this action, quoted exactly."),
});

export type MacActInput = z.infer<typeof input>;

export interface MacActOutput {
  done: true;
  app: string;
  element: string;
}

const ACTION_LABEL: Record<MacActInput['action'], string> = {
  press: '버튼 누르기',
  set: '글 넣기',
  menu: '메뉴 고르기',
  activate: '앱을 앞으로 가져오기',
};

function steps(target: readonly string[] | undefined): TargetStep[] | undefined {
  if (target === undefined) return undefined;
  const parsed = target.map(parseStep);
  return parsed.every((step): step is TargetStep => step !== undefined) ? parsed : undefined;
}

function lastLabel(value: MacActInput): string {
  if (value.action === 'menu') return value.menu?.at(-1) ?? '';
  const last = steps(value.target)?.at(-1);
  return last?.title ?? '';
}

function shapeRefusal(value: MacActInput): string | undefined {
  if (value.action === 'press' || value.action === 'set') {
    if (value.target === undefined) return 'press/set에는 target이 필요해요.';
    if (steps(value.target) === undefined) return `target의 각 단계는 ${STEP_HINT} 모양이어야 해요.`;
  }
  if (value.action === 'set' && value.value === undefined) return 'set에는 넣을 value가 필요해요.';
  if (value.action === 'menu' && value.menu === undefined) return 'menu에는 메뉴 경로가 필요해요.';
  return undefined;
}

/** Only the owner's own message in this turn can start app control; a job, a button or a read page cannot. */
function askedRefusal(value: MacActInput, call: ToolCallContext): string | undefined {
  const message = call.grounding[0];
  if (call.conversation === undefined || message === undefined) {
    return '다른 앱 조작은 주인이 대화에서 직접 부탁했을 때만 해요.';
  }
  if (!evidenceFound(value.evidence, [message])) {
    return 'evidence가 주인의 이번 메시지에 없어요. 주인이 이번에 부탁한 말을 그대로 인용해 주세요.';
  }
  return undefined;
}

function fieldRefusal(value: MacActInput, shell: boolean): string | undefined {
  if (value.action !== 'set' && value.action !== 'press') return undefined;
  const last = steps(value.target)?.at(-1);
  if (last === undefined) return undefined;
  const secure = secureFieldRefusal(last.role, value.action === 'set' ? last.title : undefined);
  if (secure !== undefined) return secure;
  if (value.action === 'set' && shell && /[\r\n]/.test(value.value ?? '')) {
    return '터미널에는 줄바꿈이 든 글을 넣지 않아요. 한 줄로 확인한 뒤 실행은 직접 해 주세요.';
  }
  return undefined;
}

/**
 * Tool "mac.act": one action in another app. It always shows a card (even for plain writes, and never under a
 * "just do it" rule), refuses banks, payment, wallet and password apps, and never types into password fields.
 */
export function macActTool(client: MacAppsClient): Tool<MacActInput, MacActOutput> {
  return {
    name: 'mac.act',
    description:
      'Do one thing in another running Mac app the owner asked for in this message: press a button, set a text field, ' +
      'choose a menu item or bring the app to the front. Read the window with mac.read_window first. Every action asks ' +
      'the owner. Banking, payment, wallet and password apps are read-only; password fields are never typed into.',
    input,
    effects: ['write'],
    effectsFor(value): readonly Effect[] {
      return value.action === 'press' || value.action === 'menu' ? effectsOfLabel(lastLabel(value)) : ['write'];
    },
    reject(value, call) {
      const category = categorize({ name: value.app, bundle: value.app });
      return (
        shapeRefusal(value) ??
        askedRefusal(value, call) ??
        actRefusal(category) ??
        fieldRefusal(value, category === 'shell')
      );
    },
    // A note makes the executor ask every time, whatever confirmWrites says, and keeps "from now on" rules away.
    uncertainty(value) {
      return cardNote(categorize({ name: value.app, bundle: value.app }));
    },
    describe(value) {
      const lines = [`앱: ${value.app}`, `동작: ${ACTION_LABEL[value.action]}`];
      if (value.action === 'menu') lines.push(`메뉴: ${(value.menu ?? []).join(' > ')}`);
      if (value.action === 'press' || value.action === 'set') lines.push(`대상: ${(value.target ?? []).join(' > ')}`);
      if (value.action === 'set') lines.push(`넣을 글: ${value.value ?? ''}`);
      return lines.join('\n');
    },
    async run(value) {
      const app = await resolveApp(client, value.app);
      // Checked again on the real app: the name the model gave may not have shown what it is.
      const category = categorize(app);
      const refused = actRefusal(category) ?? fieldRefusal(value, category === 'shell');
      if (refused !== undefined) throw new Error(refused);
      const target = steps(value.target) ?? [];
      const result =
        value.action === 'activate'
          ? await client.activate(app.bundle)
          : value.action === 'menu'
            ? await client.menu(app.bundle, value.menu ?? [])
            : value.action === 'press'
              ? await client.press(app.bundle, target)
              : await client.set(app.bundle, target, value.value ?? '');
      const element = result.label !== '' ? `${result.role}[${result.label}]` : result.role;
      return { done: true, app: app.name, element };
    },
  };
}
