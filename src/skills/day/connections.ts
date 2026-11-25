import { Contracts } from '../../core/contracts/index.js';
import type { HealthCheck, HealthFinding } from '../../core/contracts/health.js';
import type { PluginContext } from '../../core/plugin/types.js';

const PHONE_STALE_HOURS = 6;

/**
 * What quietly stops the day features from working, in plain words for 상태 점검: the phone has not reported for
 * hours (no location, no card notices), Google lacks the calendar-list permission (only the main calendar), no browser
 * agent (no web errands or route cards).
 */
export function connectionsCheck(ctx: PluginContext): HealthCheck {
  return {
    id: 'day.connections',
    async run(now) {
      const findings: HealthFinding[] = [];
      const phone = ctx.tryUse(Contracts.phoneSignals);
      if (phone !== undefined) {
        const seen = await phone.lastSeen().catch(() => undefined);
        const hours = seen === undefined ? undefined : (now.getTime() - seen.getTime()) / 3_600_000;
        const stale = hours === undefined || hours > PHONE_STALE_HOURS;
        findings.push({
          id: 'day.phone-signals',
          area: 'ops',
          ok: !stale,
          line: stale ? (seen === undefined ? '휴대폰 신호가 한 번도 오지 않았어요(위치·카드 알림 없음).' : `휴대폰 신호가 ${String(Math.floor(hours ?? 0))}시간째 없어요.`) : '휴대폰 신호가 오고 있어요.',
          ...(stale ? { fix: '휴대폰 앱의 "휴대폰 신호" 화면에서 권한을 켜고 "지금 보내 보기"를 눌러 주세요.' } : {}),
        });
      }
      const calendar = ctx.tryUse(Contracts.calendarRead);
      if (calendar?.calendars !== undefined) {
        const list = await calendar.calendars().catch(() => undefined);
        if (list?.limited === true) findings.push({ id: 'day.calendar-list', area: 'ops', ok: false, line: '기본 캘린더만 읽혀요(캘린더 목록 권한 없음).', fix: '비서 맥에서 `ax-kit connect google`을 한 번 더 해 주세요.' });
      }
      if (ctx.tryUse(Contracts.webAgent) === undefined) {
        findings.push({ id: 'day.web-agent', area: 'ops', ok: false, line: 'Aside(브라우저)가 없어서 웹 심부름·경로 안내·키 없는 검색을 못 해요.', fix: '비서 맥에 Aside를 설치하고 로그인해 주세요.' });
      }
      return findings;
    },
  };
}
