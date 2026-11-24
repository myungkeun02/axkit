import { isAbsolute } from 'node:path';
import type { Config } from '../core/config/schema.js';
import type { SecretStore } from '../core/secrets/types.js';
import { chooseMany, confirm } from './prompt-kit.js';
import type { Prompter } from './prompter.js';

export const GITHUB_TOKEN_SECRET = 'github.token';

export interface OptionalFeature {
  /** Plugin ids switched together. */
  ids: readonly string[];
  title: string;
  /** What it does, what can go wrong and what the person still does. Shown before the question. */
  notice: readonly string[];
  defaultOn: boolean;
  /**
   * A pack for one line of work (recruiting…): never offered in setup to everyone. The assistant suggests it after
   * its first look when the owner's files show that work; setup lists it only once it is on (to turn it off).
   */
  pack?: true;
}

export const FEATURES: readonly OptionalFeature[] = [
  {
    ids: ['connector.kakao-desktop'],
    title: '카톡 PC 읽기 (맥용 카카오톡 화면)',
    notice: [
      '켜 두면 맥의 카카오톡 대화 목록과 미리보기만 읽어요. 방을 열지 않아서 상대에게 읽음 표시가 가지 않아요.',
      '연락처 기억, 밀린 답장, 약속 일정 제안, 카드사 알림톡 지출 정리에 써요.',
      '주의: 카카오 약관은 자동화 도구 사용을 제한할 수 있어 계정 제한 위험이 있어요. 손쉬운 사용 권한이 필요해요.',
      '보내기는 매번 승인 카드로 확인하고, kmsg(brew install channprj/tap/kmsg)가 있어야 해요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['connector.discord-app'],
    title: '디스코드 앱 화면 읽기',
    notice: [
      '내 디스코드 앱 화면(DM 목록·열려 있는 대화)만 읽어요. 내 계정 토큰을 쓰는 셀프봇이 아니에요.',
      '주의: 그래도 디스코드는 사용자 계정 자동화를 금지해 계정이 정지될 수 있어요. 읽기만 하고 보내기는 없어요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['connector.browser', 'skill.browser'],
    title: '브라우저 심부름',
    notice: [
      '이 맥의 브라우저(Playwright 또는 쓰시는 브라우저 에이전트 CLI)로 페이지를 읽고 작업을 맡겨요.',
      '로그인·결제·약관 동의는 비서가 하지 않고 그 화면에서 멈춰 직접 하시도록 안내해요. 작업 맡기기는 매번 승인해요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['skill.errands'],
    title: '생활 심부름 (기차표·식당 예약·장바구니)',
    notice: [
      'KTX·SRT 좌석을 찾아 예매 버튼 앞까지, 식당은 [예약하기] 앞까지, 쇼핑은 장바구니까지만 해 두고 나머지는 직접 누르시게 넘겨요.',
      '결제·카드 번호·비밀번호·로봇 확인은 비서가 하지 않아요. 예약금이 있거나 취소 규정이 분명하지 않으면 먼저 여쭤봐요.',
      '빈자리 감시는 요청하실 때만, 10분보다 자주 조회하지 않고 24시간 안에 끝나요. 코레일·SRT는 매크로를 막으니 잦은 조회는 하지 않아요.',
      '브라우저 심부름이 함께 켜져요. 심부름마다 승인 카드로 확인해요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['skill.dev-assist'],
    title: '개발 보조 (GitHub)',
    notice: [
      '지정한 저장소에서 요청·이슈를 받아 브랜치·커밋을 만들고 테스트 결과를 붙여 초안 PR까지 만들어요. 머지는 하지 않아요.',
      'PR 만들기는 보내기라 매번 승인해요. GitHub 토큰은 Keychain에만 저장해요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['connector.macos-ocr'],
    title: '영수증 글자 읽기 (이 맥에서 OCR)',
    notice: ['PDF·사진 영수증의 글자를 이 맥의 Vision으로 읽어 금액·가맹점을 맞춰요. 밖으로 보내지 않아요.'],
    defaultOn: true,
  },
  {
    ids: ['connector.mac-apps'],
    title: '맥 앱 대신 누르기 (손쉬운 사용)',
    notice: [
      '부탁하시면 켜져 있는 앱의 창을 읽고, 버튼 누르기·글 넣기·메뉴 고르기를 해요. 앱을 직접 실행하지는 않아요.',
      '누르기·입력은 하나하나 승인 카드로 확인해요. "앞으로 그냥 해" 규칙도 적용되지 않아요.',
      '은행·결제·증권·지갑 앱과 비밀번호 관리 앱·키체인은 읽기만 하고, 비밀번호 칸은 읽지도 입력하지도 않아요.',
      '터미널과 시스템 설정은 항상 경고와 함께 물어요. 손쉬운 사용 권한(시스템 설정 > 개인정보 보호 및 보안)이 필요해요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['connector.apple-reminders'],
    title: '할 일 ↔ 미리 알림 동기화',
    notice: [
      '비서의 할 일을 이 맥의 미리 알림 앱(기본 목록)과 10분마다 양쪽으로 맞춰요. 아이폰 미리 알림에서 고친 것도 들어와요.',
      '양쪽에서 고쳤으면 더 나중에 고친 쪽을 따라요. 한쪽에서 없어졌다고 다른 쪽을 지우지 않고 표시만 해요.',
      '처음 동기화할 때 미리 알림 접근을 묻는 창이 떠요. 거절하셨으면 시스템 설정 > 개인정보 보호 및 보안 > 미리 알림에서 켜 주세요.',
      '알림 시각은 비서가 따로 챙겨서 미리 알림 앱에는 알람을 넣지 않아요. Google Tasks보다 이쪽을 할 일 목록으로 써요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['skill.tuning'],
    title: '자기 개선 (주 1회 개선 제안·효과 측정)',
    notice: [
      '거절·수정하신 카드, 실패·적체·알림 양을 모아 일주일에 한 번 개선을 제안해요. 누르셔야만 적용돼요.',
      '적용한 것은 1주 뒤 효과를 재고, 효과가 없으면 되돌리기를 제안해요. 기록은 "개선 기록" 문서에 쌓여요.',
    ],
    defaultOn: true,
  },
  {
    ids: ['skill.company'],
    title: '회사 모드 (팀 봇)',
    notice: [
      '팀(예: 운영·글쓰기·개발)을 정해 두면 맡긴 일을 팀장이 계획하고 팀원이 하고 팀장이 검토한 뒤 하루 한 번 묶어 보고해요.',
      '동시에 여는 일 수와 오래 멈춘 일 자동 닫기, 회사 모드 전용 하루 모델 예산이 처음부터 걸려 있어요.',
      '보내기·결제·삭제·출시는 봇끼리 승인할 수 없고 매번 직접 확인하셔야 해요. 개발 팀은 초안 PR까지만 해요.',
    ],
    defaultOn: false,
  },
  {
    ids: ['skill.talent'],
    title: '인재 소개 팩 (이력서 → 후보자 명부)',
    pack: true,
    notice: [
      '사람을 소개하거나 채용을 돕는 일을 하신다면 켜 주세요. 처음 알아보기가 찾은 이력서(PDF·Word·글 파일)를 후보자 명부로 정리해요.',
      '이름·경력·기술·희망 조건을 뽑아 두고, 대화로 "자바 8년차 이상 후보"처럼 찾을 수 있어요. 같은 사람의 이력서 여러 개는 하나로 묶어요.',
      '명부는 이 맥에만 저장돼요. 연락처는 코드로 파일에서 읽고 AI 모델에는 보내지 않아요. PDF는 이 맥의 글자 읽기로 읽어요.',
      '다른 사람의 개인정보라서, 이력서 주인의 동의 범위 안에서 써 주세요.',
    ],
    defaultOn: false,
  },
];

/** A starting set of teams; the owner edits config.json to change them. Dev only when dev-assist has a repo. */
export function starterTeams(devRepo: string | undefined): Record<string, unknown>[] {
  const teams: Record<string, unknown>[] = [
    {
      id: 'ops',
      name: '운영',
      role: '일정·자료·문서 정리와 반복 업무 점검',
      scope: ['정리', '문서', '일정', '점검', '목록'],
    },
    {
      id: 'writing',
      name: '글쓰기',
      role: '공지·소개글·메일 초안 작성 (보내기는 대표가 직접)',
      scope: ['글', '초안', '공지', '소개', '메일', '마케팅'],
    },
  ];
  if (devRepo !== undefined) {
    teams.push({
      id: 'dev',
      name: '개발',
      role: '작은 코드 수정과 초안 PR (머지·배포 없음)',
      scope: ['코드', '버그', '수정', '개발', 'PR'],
      kind: 'dev',
      repo: devRepo,
    });
  }
  return teams;
}


export interface OptionalStepDeps {
  prompter: Prompter;
  secrets: SecretStore;
  /** Kept for callers; the feature texts are Korean either way. */
  language?: string;
  existing?: Config;
}

export type OptionalPlugins = Record<string, Record<string, unknown>>;

function wasOn(existing: Config | undefined, feature: OptionalFeature): boolean | undefined {
  const entry = feature.ids[0] === undefined ? undefined : existing?.plugins[feature.ids[0]];
  return entry === undefined ? undefined : entry.enabled === true;
}

async function askRepo(prompter: Prompter, existing: Config | undefined): Promise<Record<string, unknown>> {
  const current = existing?.plugins['skill.dev-assist']?.['repos'];
  if (Array.isArray(current) && current.length > 0) return { repos: current };
  const slug = await prompter.text('저장소 (owner/name, 비우면 나중에): ', {
    validate: (value) =>
      value === '' || /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value) ? undefined : 'owner/name 모양으로 적어 주세요',
  });
  if (slug === '') return { repos: [] };
  const path = await prompter.text('이 맥에 받아 둔 폴더 (절대 경로): ', {
    validate: (value) => (isAbsolute(value) ? undefined : '/로 시작하는 절대 경로를 적어 주세요'),
  });
  const test = await prompter.text('테스트 명령 (기본 pnpm test): ', { default: 'pnpm test' });
  return { repos: [{ slug, path, test: test.split(/\s+/).filter((part) => part !== '') }] };
}

async function askToken(prompter: Prompter, secrets: SecretStore): Promise<void> {
  if (await secrets.has(GITHUB_TOKEN_SECRET)) return;
  prompter.say('GitHub 토큰: 저장소 하나만 고른 fine-grained 토큰(Contents·Pull requests 쓰기, Issues 읽기)을 권해요.');
  const token = (await prompter.secret('GitHub 토큰 (비우면 나중에 `ax-kit secret set github.token`): ')).trim();
  if (token !== '') await secrets.set(GITHUB_TOKEN_SECRET, token);
}

/** Turning Reminders sync on pins the to-do list to it; turning it off unpins it again. */
export function remindersSource(existing: Config | undefined, enabled: boolean): Record<string, unknown> | undefined {
  const { source, ...rest }: Record<string, unknown> = existing?.plugins['skill.todo'] ?? {};
  if (enabled) return { ...rest, source: 'apple-reminders' };
  return source === 'apple-reminders' ? rest : undefined;
}

/**
 * `ax-kit setup features` (not the first setup): one checklist of every optional feature, checked where it is on now
 * (or on by default). Each one newly turned on shows its full notice — what it does, what can go wrong — and is
 * confirmed once. Returns the plugin entries to merge into config.plugins.
 */
export async function askOptionalFeatures(deps: OptionalStepDeps): Promise<OptionalPlugins> {
  const { prompter, existing } = deps;
  const listed = FEATURES.filter((feature) => feature.pack !== true || wasOn(existing, feature) === true);
  const options = listed.map((feature) => ({
    value: feature.ids[0] ?? feature.title,
    label: feature.title,
    ...(feature.notice[0] !== undefined ? { hint: feature.notice[0] } : {}),
    checked: wasOn(existing, feature) ?? feature.defaultOn,
  }));
  const picked = new Set(await chooseMany(prompter, '켤 기능을 골라 주세요 (Space로 켜고 끄기, Enter로 마치기)', options));

  const plugins: OptionalPlugins = {};
  for (const feature of listed) {
    let enabled = picked.has(feature.ids[0] ?? feature.title);
    if (enabled && wasOn(existing, feature) !== true) {
      prompter.say('');
      prompter.say(`■ ${feature.title}`);
      for (const line of feature.notice) prompter.say(`  ${line}`);
      enabled = await confirm(prompter, `${feature.title}을(를) 켤까요?`, true, ['켜기', '켜지 않기']);
    }
    for (const id of feature.ids) plugins[id] = { ...(existing?.plugins[id] ?? {}), enabled };
    // errands drive the same browser, so turning them on turns the browser errand on too
    if (enabled && feature.ids.includes('skill.errands')) {
      for (const id of ['connector.browser', 'skill.browser']) plugins[id] = { ...(plugins[id] ?? existing?.plugins[id] ?? {}), enabled: true };
    }
    if (enabled && feature.ids.includes('skill.dev-assist')) {
      plugins['skill.dev-assist'] = { ...plugins['skill.dev-assist'], ...(await askRepo(prompter, existing)) };
      await askToken(prompter, deps.secrets);
    }
    if (feature.ids.includes('connector.apple-reminders')) {
      const todo = remindersSource(existing, enabled);
      if (todo !== undefined) plugins['skill.todo'] = todo;
    }
    // no ready-made teams (운영·글쓰기): teams come from the first look's plan the owner approved, or the owner adds them
    if (enabled && feature.ids.includes('skill.company') && existing?.plugins['skill.company']?.['teams'] === undefined) {
      prompter.say('  팀은 처음 알아보기에서 고른 일 지도대로 만들어요. 따로 만들려면 앱의 팀 화면이나 대화로 말해 주세요.');
    }
  }
  return plugins;
}
