import { homedir } from 'node:os';
import { join } from 'node:path';
import { CATALOG } from '../app/llm-catalog.js';
import { APNS_SECRETS } from '../channels/app/push.js';
import { AVATAR_SECRET } from '../channels/app/avatars.js';
import type { Config } from '../core/config/schema.js';
import type { SecretStore } from '../core/secrets/types.js';
import { REFRESH_TOKEN_SECRET } from '../connectors/google/token.js';
import { docsLevelOf } from '../connectors/google/workspace-scopes.js';
import { todoSource } from '../app/plugins-workspace.js';
import { FEATURES } from './setup-optional.js';

/**
 * R18: one table of what this Mac can do right now and how to turn on the rest. The app shows only what the server
 * lists in `capabilities`, so this is also the answer to "why don't I see X in the app".
 */
export interface FeatureRow {
  id: string;
  group: '기본' | '앱' | 'AI' | 'Google' | '기능';
  name: string;
  on: boolean;
  /** One command or place to turn it on (empty when it is on). */
  how: string;
}

export interface FeatureDeps {
  config: Config | undefined;
  secrets: SecretStore;
  exists(path: string): Promise<boolean>;
  /** `which` without a shell: resolves when the command is on PATH or in Homebrew's folders. */
  hasCommand(name: string): Promise<boolean>;
  launchdLoaded(): Promise<boolean>;
  pairedDevices(): Promise<number>;
  tailscaleUp(): Promise<boolean>;
  stopped(): Promise<boolean>;
  home?: string;
}

const WHISPER_MODEL = 'ggml-large-v3-turbo.bin';

async function has(secrets: SecretStore, name: string): Promise<boolean> {
  return await secrets.has(name).catch(() => false);
}

export async function featureRows(deps: FeatureDeps): Promise<FeatureRow[]> {
  const config = deps.config;
  const home = deps.home ?? join(homedir(), '.ax-kit');
  const plugin = (id: string): boolean => config?.plugins[id]?.enabled === true;
  const app = config?.channel === 'app' || config?.channel === 'both';
  const rows: FeatureRow[] = [];
  const add = (row: FeatureRow): void => void rows.push(row);

  add({ id: 'config', group: '기본', name: '기본 설정 (비서 이름·말투·시간대)', on: config !== undefined, how: 'ax-kit setup' });
  add({ id: 'service', group: '기본', name: '맥이 켜져 있으면 늘 실행 (launchd)', on: await deps.launchdLoaded().catch(() => false), how: 'ax-kit service install' });
  add({ id: 'stop', group: '기본', name: '전체 정지 꺼짐 (보내기·결제·삭제 가능)', on: !(await deps.stopped().catch(() => false)), how: 'ax-kit resume' });

  add({ id: 'app', group: '앱', name: '아이폰 앱으로 대화', on: app, how: 'ax-kit setup → 대화할 곳에서 "휴대폰·맥 앱" 또는 "앱 + 디스코드"' });
  add({ id: 'pair', group: '앱', name: '아이폰 앱 짝 맞추기 (QR)', on: (await deps.pairedDevices().catch(() => 0)) > 0, how: 'ax-kit phone pair --app --platform ios (안드로이드는 --platform android)' });
  add({ id: 'tailscale', group: '앱', name: '밖에서도 연결 (Tailscale, 내 기기끼리만)', on: await deps.tailscaleUp().catch(() => false), how: 'brew install --cask tailscale → 맥·아이폰 모두 같은 계정으로 로그인' });
  const apns = (await Promise.all(Object.values(APNS_SECRETS).map((name) => has(deps.secrets, name)))).every(Boolean);
  add({ id: 'push', group: '앱', name: '푸시 알림 (결재 카드)', on: apns, how: `ax-kit secret set ${APNS_SECRETS.key} (·${APNS_SECRETS.keyId} ·${APNS_SECRETS.teamId}) → ax-kit phone push-test` });

  const configured = config?.llm.providers ?? [];
  const keyed = await Promise.all(configured.map(async (p) => p.apiKeySecret === undefined || (await has(deps.secrets, p.apiKeySecret))));
  const catalog = await Promise.all(CATALOG.map(async (entry) => [entry.label, await has(deps.secrets, entry.secret)] as const));
  const anyAi = keyed.some(Boolean) || catalog.some(([, on]) => on);
  add({ id: 'ai', group: 'AI', name: 'AI 연결 (하나 이상)', on: anyAi, how: '앱 더보기 › AI 연결하기, 또는 ax-kit setup' });
  for (const [label, on] of catalog) add({ id: `ai-${label}`, group: 'AI', name: `${label} 키`, on, how: '앱 더보기 › AI 연결하기' });
  const whisper = (await deps.hasCommand('whisper-cli')) && (await deps.hasCommand('ffmpeg')) && (await deps.exists(join(home, 'models', WHISPER_MODEL)));
  add({ id: 'transcribe', group: 'AI', name: '녹음 받아쓰기 (맥 안 Whisper)', on: whisper, how: 'ax-kit setup features → 녹음 받아쓰기' });
  add({ id: 'avatars', group: 'AI', name: '봇 캐릭터 그림', on: await has(deps.secrets, AVATAR_SECRET), how: 'ChatGPT(OpenAI) 키 연결' });

  const routes = (await has(deps.secrets, 'ko.kakao.rest-key')) && (await has(deps.secrets, 'ko.odsay.key'));
  add({ id: 'routes', group: '기능', name: '길찾기·일정 지도 (카카오 + ODsay)', on: routes, how: 'ax-kit secret set ko.kakao.rest-key · ax-kit secret set ko.odsay.key → 앱에서 집 위치 정하기' });

  const google = await has(deps.secrets, REFRESH_TOKEN_SECRET);
  add({ id: 'calendar', group: 'Google', name: '캘린더 보기·일정 추가', on: google && plugin('connector.google-calendar'), how: 'ax-kit connect google' });
  add({ id: 'gmail', group: 'Google', name: 'Gmail 읽기·답장 초안', on: google && plugin('connector.gmail'), how: 'ax-kit connect google' });
  const organize = config?.plugins['connector.gmail']?.['organize'] === true;
  // `ax-kit setup` → 꺼진 것만 offers each of these in one Google sign-in that keeps what is on.
  const googleHow = (pick: string): string => `ax-kit setup → 꺼진 것만 이어서 설정 → "${pick}" 고르기 (또는 ax-kit connect google)`;
  add({ id: 'gmail-organize', group: 'Google', name: 'Gmail 정리 (보관·라벨, 지우지 않음)', on: google && plugin('connector.gmail') && organize, how: googleHow('Gmail 정리') });
  const docsLevel = docsLevelOf(config?.plugins['connector.google-docs']);
  const docsOn = google && plugin('connector.google-docs');
  const docsName = { read: 'Google 문서 읽기', create: 'Google 문서 읽기·새 문서·덧붙이기', edit: 'Google 문서 읽기·고치기' }[docsLevel];
  add({ id: 'docs', group: 'Google', name: docsOn ? docsName : 'Google 문서 읽기·새 문서·덧붙이기', on: docsOn, how: googleHow('Google 문서') });
  add({ id: 'docs-edit', group: 'Google', name: 'Google 문서 고치기 (내가 고칠 수 있는 모든 문서)', on: docsOn && docsLevel === 'edit', how: googleHow('문서 고치기') });
  const sheetsWrite = config?.plugins['connector.google-sheets']?.['write'] === true;
  const sheetsOn = google && plugin('connector.google-sheets');
  add({ id: 'sheets', group: 'Google', name: `Google 시트 ${sheetsWrite ? '읽기·행 추가·칸 고치기' : '읽기'}`, on: sheetsOn, how: googleHow('Google 시트') });
  add({ id: 'sheets-write', group: 'Google', name: 'Google 시트 고치기 (행 추가·칸 고치기)', on: sheetsOn && sheetsWrite, how: 'ax-kit setup → 꺼진 것만 이어서 설정 → "시트 고치기"에서 "읽기 + 고치기"로 바꾸기 (또는 ax-kit connect google)' });
  add({ id: 'tasks', group: 'Google', name: 'Google Tasks를 할 일 목록으로', on: google && plugin('connector.google-tasks') && config !== undefined && todoSource(config) === 'backend', how: googleHow('Google Tasks') });
  add({ id: 'contacts', group: 'Google', name: 'Google 주소록에서 메일 주소·전화번호 찾기', on: google && plugin('connector.google-contacts'), how: googleHow('Google 주소록') });
  add({ id: 'drive', group: 'Google', name: 'Drive 문서 읽기·회의록 저장', on: google && plugin('connector.google-drive'), how: googleHow('Google Drive 읽기') });

  add({ id: 'scan', group: '기능', name: '첫 문서 살펴보기 → 회사별 팀', on: plugin('skill.onboarding'), how: 'ax-kit setup → 처음 문서 살펴보기' });
  for (const feature of FEATURES) {
    add({ id: feature.ids[0] ?? feature.title, group: '기능', name: feature.title, on: feature.ids.every(plugin), how: 'ax-kit setup features' });
  }
  if (plugin('connector.browser')) {
    const chromium = await deps.exists(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
    add({ id: 'chromium', group: '기능', name: '브라우저 심부름용 크롬(Chromium)', on: chromium, how: 'pnpm exec playwright install chromium' });
  }
  return rows;
}

function pad(text: string, width: number): string {
  const len = [...text].reduce((sum, ch) => sum + (/[ᄀ-ￜ]/.test(ch) ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(1, width - len));
}

/** Plain table: ✓ / ✗, name, and for ✗ the way to turn it on. */
export function formatFeatures(rows: readonly FeatureRow[]): string {
  const lines: string[] = [];
  const on = rows.filter((row) => row.on).length;
  lines.push(`켜진 기능 ${on}개 / 꺼진 기능 ${rows.length - on}개`);
  for (const group of ['기본', '앱', 'AI', 'Google', '기능'] as const) {
    const items = rows.filter((row) => row.group === group);
    if (items.length === 0) continue;
    lines.push('', `[${group}]`);
    for (const row of items) lines.push(`  ${row.on ? '✓' : '✗'} ${pad(row.name, 44)}${row.on ? '' : `켜는 법: ${row.how}`}`.trimEnd());
  }
  return lines.join('\n');
}
