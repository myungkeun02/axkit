# ax-kit 다음 기능 로드맵 (2026-11-19 조사)

근거: ① ax-hq 전체 코드 분석(`~/dev/ax-hq`) ② 국내 AI 에이전트(피클·부이·키링·카카오·네이버·에이닷·익시오·모두의 AI) 리서치.
경로 표기: `hq:` = ax-hq, `kit:` = ax-kit.

## 0. 먼저 알아둘 사실

- **ax-kit 브라우저는 지금 읽기 전용이다.** 기본 Playwright 어댑터는 주소 하나를 열어 글자만 읽는다. `browser.task`는 클릭·입력을 하지 않는다. Playwright도 아직 설치돼 있지 않다.
- **ax-hq에도 실제로 브라우저를 조작하는 에이전트는 없다.** 웹 작업 클릭은 전부 외부 앱 Aside가 한다. ax-hq에 있는 관찰→행동 루프는 QA용 `hq:src/qa/explore.ts` 하나뿐이다.
- **ax-hq의 기차 예매는 지시문 수준이다.** Aside에게 "1초마다 새로고침" 지시문을 보내는 방식이다. 코드로 짠 반복 조회 `runBookingPoll`은 테스트에서만 쓰인다.
- **국내 시장 상황**
  - 피클이 KTX 예매, 대신 전화, 정부24, 쇼핑을 실제로 실행하는 서비스로 MAU 20만 명을 넘겼다.
  - 그런데 코레일이 2026-11 무렵 자동 접속을 차단했다.
  - 카카오톡 읽기·보내기 기능은 하루 만에 중단됐고 카카오가 법적 검토를 언급했다.
  - 승인 없이 전화를 걸거나 결과를 잘못 보고하는 사고도 있었다.
- **`kit:` 확인 결과 발견한 결함**: `kit:src/core/llm/gateway.ts:76`이 모든 예외에서 `circuit.recordFailure`를 호출한다. ax-hq는 제공자 장애(로그인·한도·시간 초과·네트워크·5xx)만 센다.

## 1. 추천 순서

### 1단계 — 안전 기반 (작고 먼저 할 것)
| 항목 | 출처 | 이유 |
|---|---|---|
| 게이트웨이 회로 차단 수정: 제공자 장애만 집계 | `hq:src/llm/circuit.ts` `isVendorFault` | 형식 오류만으로 제공자가 꺼지는 문제를 막는다 |
| 프롬프트 인젝션 방어 | `hq:src/guard/injection.ts`, `service.ts` | 메일·웹·카톡 화면·OCR 같은 외부 글을 걸러야 한다. 지금은 `<data>` 태그로 감싸는 것뿐이다 |
| 전체 차단 스위치 | `hq:src/guard/kill.ts` | send·pay·delete를 한 번에 막는다. 외부로 나가는 경로 목록 테스트를 함께 둔다 |
| 넘김 요약 형식 | `hq:src/handoff/recap.ts` (66줄) | 브라우저 넘김, dev-assist, 회사 모드에서 같이 쓴다 |
| 예약 작업 복원력 | `hq:src/resilience/backoff.ts`, `outage.ts`, `job-running.ts` | 오프라인일 때 재시도 폭주를 막고, 재시작이 긴 작업을 끊지 않게 한다 |

### 2단계 — 진짜 브라우저 에이전트 (핵심)
| 항목 | 출처 | 이유 |
|---|---|---|
| Playwright 관찰→행동 루프 | `hq:src/qa/explore.ts`, `qa/web.ts`, `qa/snapshot.ts` 패턴 | ARIA 스냅샷과 ref 대상, 행동 종류, 반복·행동·마감 상한, 실패 피드백을 가져온다. 기존 넘김 감지와 안전 규칙은 유지한다 |
| 결과 형식과 체크포인트 다이제스트 | `hq:src/web/result.ts` | 승인한 내용과 실제 실행 내용이 같은지 보장한다 |
| 직렬 작업 큐 (SQLite) | `hq:src/web/queue.ts` 상태기계만 | 같은 프로필 동시 사용 문제, 결제 대기 중 새 작업 차단 |
| 절차 기억과 차단 사이트 기록 | `hq:src/life/procedure*.ts`, `source-blocks.ts` | 한 번 알아낸 절차를 90일 동안 재사용하고, 막힌 사이트는 우회하지 않는다 |
| 약관 동의 판단과 TOTP | `hq:src/web/consent.ts`, `totp.ts` | 거의 그대로 가져올 수 있다 |

### 3단계 — 밖에서 넘겨받기
| 항목 | 출처 | 이유 |
|---|---|---|
| 원격 브라우저 카드 (CDP) | `hq:src/web/card/*` (`browser-cdp.ts`, `security.ts`, `tunnel.ts`, `server.ts`, `outcome.ts`) | 폰에서 로그인·결제 단계를 직접 처리한다. 1회용 링크, 10분 제한, 작업 사이트로 범위를 묶는다. Postgres는 SQLite로, Discord 버튼은 채널 계약으로 바꾼다 |

### 4단계 — 국내 생활 심부름 (2·3단계 위에서)

> 2026-11-23: 기차·식당·쇼핑 세 줄은 선택 플러그인 `skill.errands`(기본 꺼짐)로 구현 — `docs/APP-PROTOCOL.md` §25. 서류·지원금은 남음.
| 항목 | 출처·근거 | 범위 / 위험 |
|---|---|---|
| 기차 빈자리 감시와 예약 | `hq:src/web/booking.ts`, `life/booking.ts`; 피클 KTX | **기본 꺼짐.** 저빈도 조회와 알림, 승인 후 좌석 확보, 결제는 소유자가 한다. 코레일 매크로 탐지·차단, 매크로 처벌 개정안 발의(통과 미확인), 캡차·대기열 우회 금지 |
| 식당 예약 | `hq:src/life/reserve.ts`, `web/reserve-rules.ts`; 캐치테이블·네이버 | 최종 [예약하기] 화면에서 멈춘다. 선결제가 있거나 취소 규정이 불분명하면 반드시 확인받는다 |
| 쇼핑: 장바구니까지 담고 결제는 넘기기 | `hq:src/web/cart-handoff.ts`, `cart-policy.ts`; 네이버 쇼핑 에이전트 | 결제는 소유자가 한다. 기존 `watch`와 연결해 목표가에 도달하면 장바구니 담기를 제안한다 |
| 정부24·홈택스 서류, 지원금 찾기 | ax-hq 백로그, 피클, 모두의 AI | 간편인증 단계는 소유자에게 넘긴다. 지원금 찾기는 공공 API 확인이 필요하다 |

### 5단계 — 비서 품질
| 항목 | 출처·근거 |
|---|---|
| 메일 답장 안전장치: 답장이 필요한지, 근거 인용, 자동 메일 걸러내기, SPF/DKIM 위조 검사 | `hq:src/mail/necessity.ts`, `grounding.ts`, `pretriage.ts`, `ingest/mail-auth.ts` |
| 놓친 메시지 다시 답하기, 재시작으로 끊긴 대화 이어가기, 같은 말 반복 막기 | `hq:src/latte/open-loops.ts`, `catch-up.ts`, `repeat.ts` |
| 기억 정리(추가·갱신·중복)와 첨부 파일 기억 | `hq:src/knowledge/reconcile.ts`, `latte/attachments.ts` |
| 뉴스·RSS 요약 (사용자가 피드 지정) | `hq:src/news/*`, `monitor/naver-rss.ts` |
| 사용자 정의 루틴("레시피")과 상시 지시("X 나오면 알려줘") | 부이 레시피, 카카오 칸바스, `hq:docs/strategy/agent-harness.md` §6 |
| 문자에서 예약·쿠폰·택배·청구 정보 추출, 스미싱 경고 | 에이닷 AI 메시지, 익시오 (기존 폰 신호 경로 확장) |
| 무시 규칙을 한 번에 학습 | `hq:src/classify/learned.ts`, `meaningless.ts`, `briefing/candidates.ts` |
| 재구매 알림, 자동 삭제를 되돌리는 휴지통 | `hq:src/life/purchases.ts`, `nudges.ts`, `ops/trash.ts` |

### 6단계 — 맥 확장
| 항목 | 출처 |
|---|---|
| 맥 앱 제어 (손쉬운 사용으로 쓰기 가능). 금융·금고 앱은 읽기만, 터미널은 항상 확인, 비밀번호 칸은 거부 | `hq:src/desktop/policy.ts`, `ax.swift`, `driver.ts`, `service.ts` |
| Apple 미리 알림 양방향 동기화, 음악 제어 | `hq:src/apple/reminders.swift`, `service.ts` |

### 나중에 / 선택 (기본 꺼짐)
- **자동 실행 승격**: 같은 행동을 20번 확인하고 95% 이상 맞으면 자동 실행하고 결과만 보고한다(`hq:src/act/shadow.ts`, `auto-report.ts`). 1·2단계 실행 기록이 쌓인 뒤에 한다.
- **여러 모델이 서로 검증**(`hq:src/council/*`): 비용이 커서 pay·send에만 선택으로 둔다.
- **지식 그래프**(`hq:src/graph/*`), **차트 이미지**(`hq:src/dashboard/png.ts`, `charts.ts`).
- **dev-assist 검증 강화**: 다른 회사 모델로 검증, 기존 테스트를 고쳐 통과시키는 꼼수 차단, gitleaks, best-of-N, 의존성 취약점 검사(`hq:src/engineer/verify.ts`, `test-guard.ts`, `sentinel/*`).
- **LLM 평가와 리플레이**(`hq:src/llm/eval.ts`, `replay.ts`): 더 싼 모델로 바꿀 근거를 만든다.
- **에이전트끼리 약속 잡기** (피클, 카카오 A2A).
- **대신 전화 걸기** (피클, 에이닷): 난이도와 위험이 모두 높다. 클라우드 전화와 음성 모델이 필요하고, 걸 때마다 승인받고, 처음에 AI라고 밝혀야 한다. 통신비밀보호법·개인정보 쟁점이 있다.
- **통화 녹음 요약 → 할 일·일정** (에이닷, 익시오): 폰 녹음 파일을 맥에서 로컬로 받아 적는다.

### 하지 않는 것
- 매크로 티켓팅, 캡차 자동 풀기, 대기열 우회 (`hq:docs/strategy/agent-capability-backlog.md` #25).
- 카카오톡 자동 보내기 확대. **ax-kit에는 이미 `connectors/screen-chat` 카톡 보내기가 있다.** 피클이 이 기능으로 중단됐으니 기본 꺼짐과 확인 카드를 유지하고, 위험 고지를 다시 확인해야 한다.
- 결제수단·카드번호 자동 입력. 결제 PIN 자동 입력(ax-hq `executors.ts`)은 그대로 가져오지 않고 pay 효과 정책으로 다시 정한다.
- ax-hq 제품·회사 전용 기능(`huyeor`, `pg`, `sre`, `store`, `qa`, `kpi`, `perf`, `org`·`teams` 대부분).

## 2. ax-hq → ax-kit 바꿔야 할 기반
- Postgres(`FOR UPDATE SKIP LOCKED`, 어드바이저리 락, jsonb) → SQLite + 단일 프로세스 잠금, JSON 텍스트
- P0~P4 우선순위 → 효과(read·write·send·pay·delete): 조회 = read, 준비 = write, 제출·결제 = pay, 장바구니 넘김 = write(결제는 소유자)
- Discord 버튼·스레드 → ax-kit 채널 계약(`ChannelHub`, 확인 카드)
- `guard/kill` → `core/switches`에 전체 차단 추가
- Aside CLI → 쓰지 않음. 필요하면 `cli-agent.ts`처럼 어댑터로만 둔다.

## 3. 확인 못 한 것
- 키링 공식 기능·가격, 부이 결제 설계, 네이버 개인형 에이전트 앱 출시 여부
- 철도사업법 매크로 개정안 통과 여부, AI 통화녹음 관련 법 해석
- ax-kit 비서 루프에 "묻기 전에 먼저 찾아보기" 규칙이 있는지, 반복 리마인더를 지원하는지, 메일 답장 초안이 실제로 있는지
- 게이트웨이에서 응답 형식 오류가 실제로 예외 경로로 들어오는지 (제공자 구현에 따라 다름)
