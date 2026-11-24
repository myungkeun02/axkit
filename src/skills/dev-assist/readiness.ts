import { Contracts } from '../../core/contracts/index.js';
import type { HealthCheck } from '../../core/contracts/health.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { DevConfig } from './config.js';

/** Dev teams and bots the owner made, and whether any project is set up for them to work on. */
async function devTeams(ctx: PluginContext): Promise<string[]> {
  const bots = ctx.tryUse(Contracts.bots);
  if (bots === undefined) return [];
  const teams = await bots.teams().catch(() => []);
  // the assistant's own improvement room works on ax-kit itself, not on the owner's projects
  return teams.filter((team) => team.kind === 'dev' && team.id !== 'team-ax-dev').map((team) => team.name);
}

/** Doctor and the weekly report: dev teams with nothing to work on is a setup gap, said in plain words. */
export function devReadiness(ctx: PluginContext, config: DevConfig): HealthCheck {
  return {
    id: 'dev.readiness',
    async run() {
      const teams = await devTeams(ctx);
      if (teams.length === 0) return [];
      const ok = config.repos.length > 0;
      return [
        {
          id: 'ops.dev-no-repos',
          area: 'ops',
          ok,
          line: ok ? `개발 팀 ${teams.length}개, 작업할 프로젝트 ${config.repos.length}개` : `개발 팀이 ${teams.length}개 있지만 작업할 프로젝트가 하나도 연결되지 않았어요`,
          ...(ok ? {} : { fix: "대화에서 '개발 팀이 일할 프로젝트 연결해 줘'라고 말하면 이 맥에서 찾아서 연결해요" }),
        },
      ];
    },
  };
}

/**
 * For every turn while dev teams exist: what is set up, so the assistant notices a gap itself, fixes what it can
 * (dev.add_repo) and tells the owner in plain words what only they can do.
 */
export function devContextSection(ctx: PluginContext, config: DevConfig): (text: string) => Promise<string | undefined> {
  return async () => {
    const teams = await devTeams(ctx);
    if (teams.length === 0) return undefined;
    const repos = config.repos.map((repo) => `${repo.slug} (${repo.path.replace(/^\/Users\/[^/]+/, '~')})`);
    return [
      '## 개발 팀이 일할 준비 (data)',
      `개발 팀: ${teams.slice(0, 12).join(', ')}`,
      repos.length > 0 ? `연결된 프로젝트: ${repos.join(', ')}` : '연결된 프로젝트: 없음 — 개발 팀은 지금 코드를 고칠 수 없어요.',
      '개발 일을 받으면 먼저 dev.repos로 확인하세요. 그 팀의 프로젝트가 연결되지 않았으면 dev.repos의 unregistered에서 맞는 폴더를 찾아 dev.add_repo로 연결하고 시작하세요. 큰 폴더에 커밋이 없어도 그 안의 하위 폴더(apps/…, sites/…)가 실제 코드 저장소일 수 있으니 먼저 살펴보세요. 맞는 폴더가 여럿이면 하나만 골라 달라고 물으세요.',
      '스스로 할 수 없는 준비(커밋이 하나도 없는 폴더, 이 맥에 없는 프로젝트, 로그인·권한)는 "무엇이 없어서 → 무엇을 하면 되는지"를 개발 용어 없이 한두 문장으로 말하세요. 예: "홈페이지 폴더에 아직 저장된 버전이 없어서 고칠 수 없어요. 그 폴더에서 처음 버전을 한 번 저장(커밋)해 주시면 바로 시작할게요."',
      '서비스가 잘 도는지, 오류가 있는지는 service.list와 service.logs로 직접 보세요.',
      '주인이 개발 팀이 알아서 계속 개발하길 원하면 연결된 프로젝트마다 dev.autopilot을 켜세요(매일 PM이 할 일 하나를 고르고, 개발·테스트 후 QA가 검토해서 알려 줘요. 합치거나 배포하지 않아요).',
    ].join('\n');
  };
}
