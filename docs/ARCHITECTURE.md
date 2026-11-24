# ax-kit 아키텍처 (v0.10, 2026-11-20 — 길 찾기·루틴·메일 정리·Google 문서·브라우저 넘김)

> ax-kit(가칭)은 맥미니(macOS)를 서버로 쓰는 1인용 AI 비서 키트다. 사용자는 디스코드에서 비서와 대화하고,
> 휴대폰은 앱 개발 없이 단축어/자동화 파일 하나로 연결한다. 비서 이름은 사용자가 정한다.
>
> - 이 문서: **코드 구조·경계·인터페이스·설치 흐름**(구현 기준).
> - [DESIGN.md](DESIGN.md) (v0.1): 비서 하네스의 동작 규칙(문맥 조립, 흐름 게이트, 기억, 자기 조정)과 기능 목록.
>   두 문서가 충돌하면 **이 문서가 우선**한다. v0.1의 manifest(YAML) 방식은 TypeScript 플러그인 선언(§3)으로 바뀌었다.

목차

1. 목표와 범위
2. 계층과 의존성 방향
3. 플러그인 모델
4. 핵심 인터페이스
5. 확인(승인) 정책
6. LLM 게이트웨이와 비용 상한
7. 데이터 저장: SQLite
8. 설치·초기 세팅 흐름
9. 모바일 브리지
10. 보안·개인정보
11. 원본 AX에서 가져올 것 / 뺄 것 / 다시 짤 것
12. 디렉터리 구조
13. 코딩 규칙
14. 테스트 전략
15. 로드맵
16. 정해야 할 것

---

## 1. 목표와 범위

- **한 사람 = 맥미니 한 대.** 대화 채널은 디스코드 봇, 전용 Android 앱(디스코드 없이), 또는 둘 다(M6, `config.channel`). 다중 사용자 SaaS가 아니다.
- **로컬 우선.** 데이터·비밀은 맥미니에만. 밖으로 나가는 것은 사용자가 고른 LLM 호출과 연결한 서비스 API뿐.
- **기본 포함**: 디스코드 대화, 일정, 할 일, 메일 요약·초안, 아침 브리핑, 감시(가격·페이지 변화), 지출 정리, 기억(지식), 휴대폰 신호,
  **한국 생활 기능**(날씨·장소·교통·택배·최저가 — 2026-11-17 결정으로 선택이 아니라 기본 포함, 언어가 `ko`일 때 켜짐).
- **선택 플러그인**(기본 꺼짐, 한국어 setup에서 위험 고지 후 물어봄): 카톡 PC 읽기, 디스코드 앱 화면 읽기, 브라우저 심부름, GitHub 개발 보조(초안 PR까지, 머지 안 함), 영수증 OCR, 자기 조정.
- **기본 제외**: 특정 회사 제품 운영, 결제대행(PG) 연동. 회사 운영용 팀 봇은 **선택 플러그인 `skill.company`(회사 모드, 기본 꺼짐)** 로만(§15.4).

## 2. 계층과 의존성 방향

```
                ┌──────────────────────────── cli (setup · doctor · start · secret · phone) ─┐
                │                         app (조립: 설정 → 플러그인 → 시작)                  │
                └───────────────┬──────────────┬───────────────┬──────────────┬────────────┘
                                │              │               │              │
                          channels/       connectors/        skills/       mobile/
                          (디스코드)     (Gmail·Calendar·   (브리핑·일정·   (휴대폰 브리지)
                                          Drive·파일·카톡…)  메일·감시…)
                                │              │               │              │
                                └──────────────┴──────┬────────┴──────────────┘
                                                      ▼
   core: config · plugin host · event bus · scheduler · LLM gateway · secrets(Keychain) · policy(확인) ·
         tools(등록·실행) · conversation(라우터) · store(SQLite) · log/audit
```

규칙(§13에서 lint로 강제):

1. `core`는 아무 계층도 import하지 않는다. 외부 의존은 `node:*`와 `zod`뿐.
2. `channels` / `connectors` / `skills` / `mobile`은 **`core`만** import한다. 서로 import하지 않는다.
   스킬이 일정이 필요하면 `CalendarSource` **능력(capability)** 을 요청하고, 그것을 Google 연결기가 제공한다(의존성 역전).
3. `app`은 모든 플러그인 계층을 알고 조립한다. `cli`는 `app`을 쓴다. 역방향 금지.
4. 공급사 SDK(discord.js 등)는 그것을 감싸는 플러그인 폴더 안에서만 import한다.

## 3. 플러그인 모델

모든 기능은 플러그인이다. 채널·연결기·스킬·브리지 모두 같은 모양이고, 설정의 `plugins.<id>.enabled`로 열고 닫는다
(코드 수정 없이 기능 추가·제거 = 개방-폐쇄).

```ts
interface Plugin {
  manifest: PluginManifest;               // id, kind, title, secrets(읽을 수 있는 Keychain 이름), needs(필요 능력)
  setup(ctx: PluginContext): PluginInstance | void | Promise<…>;   // 도구·핸들러·작업·능력 등록
}
interface PluginInstance { start?(): Promise<void>; stop?(): Promise<void> }
```

- **등록**: `app/plugins.ts`의 `builtinPlugins(config)`가 목록을 만들고, `PluginHost.add()`로 넣는다.
  제3자 플러그인은 나중에 `ax-kit-plugin-*` npm 패키지를 `config.plugins`에 적어 불러온다(M3). 제3자 플러그인의
  `send`/`pay`/`delete` 도구는 사용자가 플러그인별로 허락하기 전까지 등록되지 않는다.
- **순서**: `needs`가 모두 제공된 플러그인부터 `setup` → 그다음 `start`(같은 순서) → 종료는 역순. 빠진 능력이 있으면
  어느 플러그인이 무엇을 못 찾는지 한 번에 알려주고 시작하지 않는다.
- **PluginContext** (작은 인터페이스만, 구현체는 모름):
  `config`(자기 섹션) · `assistant`(이름·언어·시간대) · `secrets`(manifest에 적은 이름만 읽힘) · `bus` · `scheduler` ·
  `llm` · `log` · `kv`(자기 네임스페이스) · `registerTool` · `registerHandler` · `provide(cap, impl)` · `use(cap)`.
- **능력(capability)** = 타입이 붙은 키. `defineCapability<CalendarSource>('calendar.source')`. 제공자는 하나.
  채널은 직접 능력을 제공하지 않고 `Caps.channels`(core `ChannelHub`)에 끝점(replier·owner·confirmer)을 **등록**한다(M6).
  앱이 허브 하나로 `Caps.replier`·`Caps.confirmer`·`owner.channel`을 제공한다: 답은 온 채널로, 먼저 보내는 알림은 모든 채널로,
  확인 카드는 모든 채널에 띄우고 **먼저 답한 쪽이 결정**, 나머지 카드는 `ConfirmOptions.signal`로 닫힌다. 채널이 없으면 확인은 거절.

플러그인 종류별 책임:

| 종류 | 하는 일 | 예 |
|---|---|---|
| channel | 사용자와 말 주고받기, 승인 카드 | `channel.discord`, `channel.app`(M6) |
| connector | 바깥 서비스·OS 데이터를 **능력**과 **도구**로 노출 | `connector.google-calendar`, `connector.gmail`, `connector.local-files`, `connector.kakao-desktop`(선택) |
| skill | 사용자에게 가치를 만드는 흐름: 메시지 핸들러, 예약 작업, 도구 | `skill.assistant`(LLM 대화), `skill.briefing`, `skill.watch` |
| bridge | 기기에서 오는 신호를 받아 이벤트로 | `bridge.mobile` |

## 4. 핵심 인터페이스

실제 정의는 `src/core/**/types.ts`. 요약:

```ts
// 대화 — 채널은 IncomingMessage를 bus에 내고, 라우터가 우선순위 순으로 핸들러를 부른다
interface IncomingMessage { id; conversation: ConversationRef; authorId; fromOwner: boolean; text; receivedAt }
interface MessageHandler { id; priority: number; handle(m, replier): Promise<'handled' | 'pass'> }
interface Replier { reply(to: ConversationRef, m: { text; choices?: Choice[] }): Promise<void> }

// 이벤트 버스 — EventMap을 선언 병합으로 플러그인이 넓힌다
interface EventBus { on(name, handler): Unsubscribe; emit(name, payload): Promise<void> }   // 한 핸들러 실패가 남을 막지 않음

// 스케줄러 — 사용자 시간대 기준, 시계 주입(테스트)
type Schedule = { kind: 'every'; seconds } | { kind: 'daily'; at: 'HH:MM' };
interface Scheduler { add(job); start(); stop(); nextRun(name) }

// 비밀 — 값은 Keychain에만. 설정·DB·로그·모델에는 이름만
interface SecretStore { get(name); set(name, value); delete(name); has(name) }

// 도구 — 모델이 부를 수 있는 행동. 효과(effects)를 선언하고, 실행은 항상 ToolExecutor를 거친다
interface Tool<I, O> { name; description; input: ZodType<I>; effects: Effect[]; effectsFor?(i); describe?(i); run(i, ctx) }
interface ToolExecutor { execute(name, rawInput): Promise<ToolOutcome> }    // 검증 → 확인 정책 → 실행 → 감사 기록

// LLM
interface LlmProvider { id; complete(model, req): Promise<LlmResponse> }   // 공급사 하나, 라우팅 모름
interface LlmGateway { complete(req: { purpose; tier; sensitivity; messages; jsonSchema? }): Promise<LlmResponse> }

// 저장
interface Store { migrate(migrations); kv(namespace): KeyValueStore; close() }
```

연결기가 제공할 도메인 능력(스킬이 의존하는 쪽, `src/core/contracts/`). M1에서는 능력 이름표를 쓰는 쪽 기준으로 잘게 나눴다:
`calendar.read` · `calendar.write` · `mail.read` · `mail.draft` · `mail.send` · `todo.read` · `owner.channel` · `core.notifier`
(읽기 전용 연결기는 `mail.read`만 제공하면 된다).
M2에서 추가: `mail.awaiting` · `todo.write` · `phone.signals` · `phone.otp` · `memory.read` · `memory.write` · `people.read` ·
`life.places` · `life.weather` · `life.transit` · `life.parcel` · `life.prices`(키가 없으면 `MissingKeyError`에 발급 안내).
M3에서 추가: `spend.read`(장부, `skill.spending` 제공) · `mail.attachments` · `mail.compose`(새 초안, 보내기는 여전히 `mail.send`+승인) ·
`files.local` · `files.drive`(같은 `FileSource` 모양, 제공자가 하나라 이름을 나눔) · `web.page`(공개 주소만) — 그리고 이벤트
`money.notice`(`PaymentNotice`: 문자·앱 알림·채팅 카드 알림톡·메일 원문. 휴대폰 브리지와 선택 카톡 플러그인이 내고 지출 스킬이 받음).
M4에서 추가: `people.write`(연락처 기억에 대화 한 줄, 코드가 쓴 요약만) · `core.notice-mute`(알림 종류 끄기, 알림기가 제공) ·
`ocr.text`(이 맥 Vision 글자 읽기) · `browser.agent`(Playwright 또는 브라우저 에이전트 CLI 어댑터, 선택 `openLive`) · `browser.live`(앱에서 넘겨받는 페이지, §22) · `life.weather`의 선택 메서드
`forecast(point, ymd)` — 그리고 이벤트 `chat.preview`(화면에서 읽은 대화 목록 한 줄), `feedback.card`(카드 수락·거절·수정),
`tuning.apply`(승인된 조정; 그 영역 주인 플러그인이 적용). 프로그램 실행은 `core/process`(셸 없음, 표준입력, 출력 상한, 시간 제한)와
`ensureSwiftHelper`(플러그인의 .swift를 소스 해시 이름으로 `~/.ax-kit/bin`에 한 번 컴파일). 도구는 느린 작업용 `timeoutMs`를 둘 수 있다(최대 3시간).
M5a에서 추가: `files.scan`(폴더 훑기) · `knowledge.profile` · `knowledge.write` · `owner.review`(번호 목록 확인·고치기) · `FileSource.recent`(선택) — 이벤트 `review.answer`, 가림 `core/text/mask.ts`(`maskForModel` = `masked` 민감도의 약속). 파일 규칙(종류·크기·민감 이름 제외)은 `core/files/filter.ts`, 사용자 시간대 날짜 계산은 `core/time/local-day.ts`. 도구는 연결기가 아니라 스킬(`skill.calendar`, `skill.mail`)이 능력 위에 등록한다 —
근거 인용·상대 날짜·확인 규칙이 어떤 연결기에도 똑같이 적용되게.
M6·M7에서 추가: `mail.organize`(Gmail 보관·라벨, `gmail.modify` 선택 권한, 지우기·휴지통 없음) · `docs.read` · `docs.write` ·
`sheets.read` · `sheets.write` · `contacts.read`(Google 문서·시트·주소록, 각각 선택 권한) · `todo.backend`(할 일 저장소를 Google Tasks로) · `todo.sync`(할 일을 Apple 미리 알림과 양쪽 동기화) ·
`app.share-file`(맥 파일을 앱 대화 첨부로) · `web.agent`(Aside CLI로 오너의 로그인된 브라우저를 다루는 길 찾기) · `assistant.context` ·
`assistant.runner`(루틴·후속 확인이 비서 한 턴을 돌림) · `core.llm-control`(AI 연결·등급) · `bots.directory`(봇·팀) · `core.questions` · `core.topics`.
아래는 M2 이후 능력의 초안:

```ts
interface CalendarSource { listEvents(range): Promise<CalendarEvent[]>; createEvent?(draft): Promise<CalendarEvent> }
interface MailSource     { search(q, limit): Promise<MailSummary[]>; read(id): Promise<MailMessage>; draftReply?(id, body) }
interface FileSource     { search(q): Promise<FileHit[]>; read(path, maxBytes): Promise<string> }
interface PlaceSource    { geocode(text); nearby(loc, kind) }   // 지역팩(ko: 카카오/네이버)
interface WeatherSource  { forecast(loc, day) }
interface PhoneSignals   { latestLocation(maxAgeMin); dayTotals(day) }   // bridge.mobile이 제공
```

## 5. 확인(승인) 정책

도구는 위험 "등급" 대신 **효과(effects)** 를 선언하고, 확인 여부는 코드가 효과로 정한다(모델이 정하지 않는다).

| 효과 | 뜻 | 예 | 확인 |
|---|---|---|---|
| `read` | 보기만 | 메일 검색, 일정 보기, 날씨 | 안 함 |
| `write` | 내 데이터 변경, 되돌릴 수 있음 | 할 일 추가, 내 캘린더에 비공개 일정 | 기본 안 함(설정 `policy.confirmWrites`로 켤 수 있음) |
| `send` | 다른 사람·공개 공간에 닿음 | 메일·메시지 보내기, 초대, 게시, 공유 | **항상** |
| `pay` | 돈·포인트, 구매·예약 확정 | 주문, 예매 | **항상** |
| `delete` | ax-kit 안에서 복구 못 하는 삭제 | 메일 영구 삭제, 파일 삭제 | **항상** |

- `ALWAYS_CONFIRM = ['send','pay','delete']`는 상수다. 설정·프롬프트·플러그인이 끌 수 없다.
- `effects`는 하한이다. `effectsFor(input)`가 실제 입력으로 **올리기만** 한다(예: 일정 만들기에 참석자가 있으면 `send` 추가).
- 확인 카드: 정확한 내용(`describe(input)` — 받는 사람, 본문, 금액), 주인에게만 묶임, 1회용, 기본 30분 후 만료=거절.
  확인할 채널이 없으면 **거절이 기본**.
- 지시 출처: `fromOwner`는 채널이 설정의 owner id로만 정한다. 메일·웹·파일·도구 결과·다른 사람 말은 데이터다
  (DESIGN.md §2.3 흐름 게이트·고정 규칙은 `skill.assistant`에서 구현).
- 비밀번호·카드번호·주민번호 입력은 기능으로 두지 않는다. 로그인·2FA·결제 입력은 사람이 한다.

## 6. LLM 게이트웨이와 비용 상한

```
기능(스킬) ──LlmRequest{purpose, tier, sensitivity}──▶ RoutingLlmGateway ──▶ LlmProvider (anthropic | openai-compatible)
                                                         │ 1) 경로 고르기: tier 포함 + 허용 민감도 ≥ 요청 민감도 (설정 순서)
                                                         │ 2) 예산: 오늘/이번 달 사용액 ≥ 상한이면 over_budget
                                                         │ 3) 실패하면 다음 경로, 성공하면 사용량 기록(ledger)
```

- **공급자 종류는 두 개로 충분**: `anthropic`(Messages API), `openai-compatible`(OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio —
  `baseUrl`만 다름). 공급사 SDK 없이 `fetch`로 짠다.
- **키 넣기**: `ax-kit secret set llm.<id>.api-key`(숨김 입력, Keychain 저장). 설정 파일에는 `apiKeySecret` 이름만.
  온보딩에서 객관식으로 고르면(Anthropic / OpenAI / DeepSeek / 구독 CLI / 내 컴퓨터 모델(Ollama) / 나중에) 경로·가격이 채워진다.
- **민감도**: `public` < `masked` < `sensitive`. 기본: 사용자가 고른 주 공급자와 로컬 모델만 `sensitive`. 나머지는 `masked`까지.
  가림(masking)은 코드가 한다.
- **비용 상한**: `llm.budget.dailyUsd`(기본 1), `monthlyUsd`(기본 20). 넘으면 호출하지 않고 디스코드에 하루 한 번 알림.
  로컬 모델은 0원이라 상한 뒤에도 쓸 수 있다(경로가 있으면). 공급자별 차단기 **(M2 완료)**: 연속 3번 실패하면 5분 제외 → 시험 호출 1번 → 실패하면 제외 시간 2배(최대 30분). 호출자가 취소한 요청은 실패로 세지 않는다.
  사용량 장부·감사 기록은 SQLite(`llm_usage`, `audit` 표)에 남아 재시작해도 예산이 이어진다 **(M2 완료)**.
- **구독 CLI 공급자**(2026-11-17 결정): 사용자가 이 맥에 로그인해 둔 `claude`(Claude Code)·`codex`(Codex CLI)를 공급자 어댑터
  `claude-cli`·`codex-cli`로 부른다(API 키 없음, 비용 0으로 기록). 프롬프트는 표준입력으로만 넘겨 프로세스 목록에 안 남긴다.
  약관·사용량 한도는 사용자 책임이라는 안내 문구만 온보딩에서 보여준다.
  M2에서 이 맥으로 '안녕' 호출 확인: `claude -p --tools '' --strict-mcp-config --setting-sources project --no-session-persistence`(빈 폴더),
  `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only` + 셸·파일·브라우저·앱·플러그인 기능 끄기 + `mcp_servers={}`
  (사용자 config.toml의 MCP 서버가 붙던 문제를 `--ignore-user-config`로 막음).

## 7. 데이터 저장: SQLite

**권장: SQLite, Node 내장 `node:sqlite`** (Node 22.13+에서 플래그 없이 사용, FTS5 포함 — 이 맥에서 확인).

| 기준 | SQLite (`node:sqlite`) | Postgres (Docker/OrbStack) |
|---|---|---|
| 설치 | 없음. 네이티브 빌드도 없음(better-sqlite3 불필요) | Docker/OrbStack 설치·실행 필요, 일반 사용자에게 가장 큰 장벽 |
| 장애 | 프로세스 안. 별도 서버 다운 없음 | 원본 AX에서 OrbStack이 죽어 DB 17분 중단, 감시 장치를 따로 만들어야 했음 |
| 규모 | 1인 비서(메일 수만 통, 사실 수천 개)에 충분 | 과함 |
| 동시성 | 데몬 하나가 쓰기, WAL로 읽기 동시 | 여러 프로세스 동시 쓰기에 유리 |
| 검색 | FTS5 낱말 검색 (+선택 sqlite-vec) | tsvector + pgvector |
| 백업 | 파일 복사 / `VACUUM INTO` | pg_dump |

- 파일: `~/.ax-kit/data/ax-kit.db`(디렉터리 700, 파일 600). 첨부는 `~/.ax-kit/files/`.
- 스키마: 플러그인마다 `Migration{id:'<plugin>/<NNN>-<name>', sql}`. 공용 `kv` 테이블은 플러그인 id로 나뉜다.
- `Store.sql`(작은 SQL 인터페이스)은 core 안(사용량 장부·감사 기록)에서만 쓴다. 플러그인은 계속 `kv`만 받는다.
- `Store` 인터페이스 뒤에 두어 나중에 Postgres 어댑터를 붙일 수 있다(선택 플러그인, 기본 아님).

## 8. 설치·초기 세팅 흐름

목표: 터미널 명령 2개 + 질문 답하기 + 사람만 할 수 있는 클릭(로그인·약관·토큰 복사).

```
0) 준비      Node 22.13+ (없으면 안내: nodejs.org 설치 파일 또는 brew)
1) 설치      npx ax-kit@latest setup        (배포 방식 확정 전에는 git clone + pnpm install + pnpm ax-kit setup)
2) 온보딩    객관식 질문 (번호로 답)
             - 비서 이름(직접 입력) · 언어(한국어/English) · 시간대(자동 감지 확인)
             - 비서 말투(해요체/합쇼체/반말) · 나를 부를 이름(선택)
             - LLM: Anthropic / OpenAI / DeepSeek / Claude Code 구독 / Codex 구독 / 내 컴퓨터 모델 / 나중에 → 키는 숨김 입력
             - 아침 브리핑 시각 · 조용한 시간 · 내 데이터 변경도 물어볼지
             - 하루 예산: $0.5 / $1 / $3 / 직접
             - 연결할 것(복수): Google 메일·캘린더·드라이브 / 로컬 폴더 / 휴대폰 / GitHub
2b) 채널    (M6) 휴대폰 종류 → Android면 "휴대폰 앱으로 쓰기(디스코드 없이, 추천) / 디스코드 / 둘 다". 앱만이면 3)을 건너뛴다.
3) 디스코드  자동화 범위 ▶ 개발자 포털 링크 열기, 할 일 체크리스트 표시, 토큰 검증(GET /users/@me),
             앱 id 추출, 초대 링크 생성·열기, 연결 확인.
             사람 몫 ▶ 로그인·2FA, New Application, 약관 체크, Bot 탭에서 Message Content Intent 켜기, 토큰 복사.
             주인 지정 ▶ 터미널에 6자리 코드 표시 → 사용자가 봇에게 DM으로 코드 전송 → 그 계정이 owner
             (사용자가 개발자 모드로 user id를 찾을 필요 없음).
4) Google   사용자 자신의 OAuth 클라이언트(데스크톱 앱 유형). 단계별 링크 안내 → client JSON 경로 입력 →
             루프백 리디렉트 + PKCE로 동의 → refresh token은 Keychain.
             주의: 동의 화면이 "테스트" 상태면 refresh token이 7일 뒤 만료된다 → "프로덕션으로 게시"(미검증 경고 화면을
             사용자가 넘김) 단계를 안내에 넣는다. 공용 검증 클라이언트는 Gmail 제한 범위 보안 심사 비용 때문에 1차에서 제외.
5) 휴대폰    `ax-kit phone pair` → QR (§9). 앱이면 `ax-kit phone apk` → 설치 → `ax-kit phone pair --app` (§9.6)
6) 상시 실행 launchd LaunchAgent(`~/Library/LaunchAgents/<label>.plist`, RunAtLoad, KeepAlive, 로그는 ~/.ax-kit/logs).
             맥미니 권장 설정 안내: 잠자기 끄기, 정전 후 자동 켜기, 자동 로그인(Keychain이 로그인 세션에 묶임;
             FileVault와 자동 로그인은 함께 못 씀 → 보안/편의 선택을 사용자에게 보여줌).
7) 첫 브리핑 연결이 끝나면 바로 디스코드에 첫 브리핑(오늘 일정·읽지 않은 중요 메일·날씨) + 다음 할 일 버튼 3개.
```

- `ax-kit doctor`: Node 버전, macOS, 설정 유효성, Keychain 항목(이름만), DB 열기, launchd 상태, 휴대폰 마지막 신호 시각,
  각 플러그인의 `requirements` 검사. 실패마다 고치는 한 줄.
- 세팅은 Claude Code 같은 코딩 에이전트가 대신 진행해도 되게 CLI가 모두 비대화형 플래그도 받는다(`--name`, `--yes` 등).
  이때도 비밀값은 에이전트가 보지 않고 사용자가 숨김 입력으로 넣는다.

## 9. 모바일 브리지

### 9.1 원칙

- (M2) 휴대폰 쪽은 **기존 앱 + 가져오기 파일**. (M6, 2026-11-18 오너 결정) Android는 **전용 앱(APK 직접 설치)** 을 채택해
  신호 보내기와 대화(디스코드 대신)를 함께 한다. iOS는 여전히 단축어, Android MacroDroid 방식은 대안으로 남는다.
- 사진·음성 메모·링크 같은 "내가 보내는 것"은 **디스코드 앱 공유 시트**로 비서에게 보내면 된다(두 OS 모두 추가 세팅 0).
  모바일 브리지는 **자동으로 흘러오는 신호**(위치·걸음·문자·알림·배터리) 전용이다.
- 휴대폰이 보낸 내용은 데이터다. 지시가 되지 않는다.

### 9.2 방식 비교와 선택

| 휴대폰 쪽 | iOS | Android | 추가 설치 | 자동 트리거 | 판단 |
|---|---|---|---|---|---|
| **iOS 단축어(서명된 .shortcut 파일)** | ○ | – | 없음(기본 앱) | 개인용 자동화(시간·도착/출발·메시지 수신·배터리), iOS 17+ "즉시 실행" | **iOS 채택** |
| iOS 단축어 iCloud 링크 + 가져오기 질문 | ○ | – | 없음 | 같음 | 대안(맥이 iCloud 미로그인일 때) |
| **전용 Android 앱(ax-kit, APK 직접 설치)** | – | ○ | 앱 1개(Play·계정 없음) | 알림 리스너, 문자(선택), 위치 근접 경보+30분, 헬스 커넥트 걸음, 배터리, 공유 시트 + **대화·확인 카드** | **Android 채택(M6)** |
| MacroDroid(.macro 가져오기) | – | ○ | 앱 1개(무료, 매크로 5개 한도) | SMS/알림 수신, 위치 영역, 시간, 배터리 | Android 대안(M2 채택 → M6부터 대안) |
| Tasker(TaskerNet 링크) | – | ○ | 유료 앱 | 가장 강력(Health Connect 플러그인 등) | 고급 사용자 선택 |
| HTTP Shortcuts | – | ○ | 앱 1개(오픈소스) | 수동 위주 | 자동 신호에 약함 → 제외 |
| PWA | ○ | ○ | 없음 | 백그라운드 위치·문자·걸음 접근 불가 | 페어링/상태 페이지로만 사용 |

**iOS 파일 만들기(M2 구현·이 맥에서 서명 확인)**: 단축어 4개(위치·문자·걸음·음성 메모). `shortcuts sign`은 인터넷이 필요하고(파일당 약 5초),
입력 파일 이름이 `.shortcut`으로 끝나야 한다(아니면 "correct format" 오류) — 이 맥에서 실측. 그다음 원래 설계: 맥미니가 템플릿(plist)에 이 기기 전용 주소·토큰을 채워 `shortcuts sign --mode anyone`(macOS 내장, 이 맥에서 확인)으로
서명한다. 서명된 파일은 "신뢰하지 않는 단축어 허용" 설정 없이 바로 가져와진다. 맥이 iCloud에 로그인 안 돼 있으면 대안 경로(공개 iCloud
링크 + 가져오기 질문에 페어링 문자열 붙여넣기)를 쓴다. 자동화(트리거)는 공유가 안 되므로 사용자가 직접 만든다 → 꼭 필요한 2~3개만 안내.

### 9.3 맥미니까지의 통로

| 방식 | 휴대폰 설치 | 공개 노출 | 도메인 | 집 밖에서 | 평문 노출 지점 | 판단 |
|---|---|---|---|---|---|---|
| 같은 와이파이(LAN) | 없음 | 없음 | 불필요 | 안 됨 | 없음 | 부족 |
| **Tailscale 사설망(tailnet)** | Tailscale 앱 + 로그인 | 없음 | 불필요 | 됨(VPN 켜져 있어야) | 없음(WireGuard 종단) | **보안 우선 권장** |
| **Tailscale Funnel** | 없음 | 경로 1개만 공개(HTTPS) | 불필요(`*.ts.net`) | 됨 | 없음(TLS가 맥에서 끝남) | **편의 기본값** |
| Cloudflare Tunnel(이름 있는 터널) | 없음 | 공개 | 필요(Cloudflare DNS) | 됨 | Cloudflare 엣지에서 TLS 해제 | 도메인 가진 사용자 선택 |
| Cloudflare 빠른 터널 | 없음 | 공개 | 불필요 | 됨 | 같음 | 주소가 재시작마다 바뀜 → 제외 |

**권장안**: 맥미니에만 Tailscale을 설치하고 기본은 **Funnel**(휴대폰 설치 0, 고정 HTTPS 주소, 문자 내용이 제3자에게 평문으로 안 보임).
온보딩에서 "휴대폰에도 Tailscale을 깔 수 있다"를 고르면 Funnel을 끄고 **사설망 전용**으로 바꾼다(공개 노출 0).
Cloudflare Tunnel은 자기 도메인이 있는 사용자 선택지.

방어선(공개 경로일 때 전부 켬):

- 브리지 서버는 `127.0.0.1`에만 열고, Funnel/터널은 `/m/` 경로 하나만 연결한다.
- **기기별 토큰**(256비트 랜덤). DB에는 SHA-256 해시만, 원문은 휴대폰 파일에만. `Authorization: Bearer`.
- 요청에 `ts`(시각) 필수, ±5분 밖은 거절. 본문 16KB 상한, zod 스키마 검증, 기기별 분당 60건 제한, 실패 10회면 그 토큰 잠금 + 디스코드 알림.
- **토큰 회전**: `ax-kit phone rotate`(또는 디스코드 `/휴대폰 새토큰`) → 새 파일 QR. 이전 토큰은 7일 유예 후 폐기. 90일마다 회전 권유 알림.
  분실 시 `ax-kit phone revoke <기기>` 즉시 폐기.
- 페어링 코드: 1회용, 10분 만료, 6자리 + 링크 안의 128비트 nonce. 틀린 코드 5번이면 그 페어링은 폐기.
- 구현(M2): 수신 `POST /m/v1/ingest`, 페어링 페이지 `GET/POST /m/p/<nonce>`(6자리 입력 → 파일 링크 10분), 기본 포트 47617.
  Funnel 연결: `tailscale funnel --bg --set-path /m http://127.0.0.1:47617/m`. 상태는 `ax-kit doctor`.
- 문자·앱 알림: 원문은 채팅에 보내지 않는다. 인증번호·카드 승인은 조용히(인증번호는 메모리에만 10분), 스팸은 버리고, 나머지는 모델이
  "할 일"이 있을 때만 그 한 줄을 알린다(+'할 일에 추가' 버튼).

### 9.4 무엇을 보내나

| 신호 | iOS 방법 | Android 방법 | 쓰는 곳 |
|---|---|---|---|
| 위치 | 자동화 "도착/출발"(집·회사) + 아침/저녁 "현재 위치" | MacroDroid 위치 영역 + 주기(30분) | 장소 추천, 이동 시간, 브리핑 |
| 걸음 | 자동화 "시간"(밤 9시) → 건강 "샘플 찾기(걸음, 오늘 합계)" | 1차 미지원(Tasker+Health Connect 선택) | 하루 요약 |
| 문자 공유 | 자동화 "메시지"(특정 발신자·낱말 포함) 즉시 실행 | MacroDroid "알림 수신"(메시지 앱) — SMS 권한 없이 | 카드 승인 → 지출, 택배, 예약 |
| 인증번호 | 위와 같음(낱말 "인증"/"code") | 같음 | 10분만 보관, 비서가 웹 자동화에 쓸 때만, 디스코드에는 가림 |
| 앱 알림 | iOS는 다른 앱 알림 읽기 불가 | MacroDroid 알림 수신(앱 선택) | 선택 |
| 배터리 | 자동화 "배터리 잔량" | MacroDroid 배터리 | 저전력 시 알림 줄이기 |
| 화면 시간 | 단축어로 읽을 방법 없음 | 기본 파일엔 없음 | 수신 종류(`screen_time`)만 받아 둠(사용자가 직접 보내는 경우) |
| 음성 메모·사진·링크 | **디스코드 공유 시트** | **디스코드 공유 시트** | 받아쓰기·정리 |

본문 형식(두 OS 공통): `{"v":1,"ts":"…","items":[{"kind":"location","lat":…,"lng":…},{"kind":"sms","from":"…","text":"…"}]}`.

### 9.5 사용자가 누르는 단계(예상 — 실기기 실측은 아직)

- **iOS**: 디스코드/터미널의 QR 찍기 → 링크 열기 → "단축어 받기" → "단축어 추가" = **약 4번**. 자동화 1개당 약 6번
  (자동화 탭 → + → 트리거 → 즉시 실행 → 단축어 고르기 → 완료), 권장 3개 → 합계 약 22번, 5분 안쪽.
- **Android**: QR → Play 스토어에서 MacroDroid 설치(2번) → 링크로 .macro 받기 → MacroDroid로 열기 → 가져오기(2번) →
  알림 접근·위치 권한 허용(3~5번) = **약 10~12번**. 자동화가 파일에 들어 있어 따로 만들 필요 없음.

### 9.6 클라이언트 앱 (2026-11-19: 재개발을 위해 제거)

이전 Android(M6)·데스크톱(M7, Tauri)·iOS(M8) 앱은 저장소에서 지웠다(git 기록 `6734156` 이전에 남음). 서버 쪽은 그대로다:
`ax-kit phone pair --app`이 `client: 'app'` 기기를 만들고 앱이 `POST /m/p/<nonce>/app {code}`로 토큰을 받는다(1회용·10분·5회),
신호는 `POST /m/v1/ingest`(항목별 `at` 허용), 받기는 SSE + `events?after=`, 확인 카드는 `client: 'app'` 토큰의 답만 주인의 답으로 본다.
새 앱은 아래 §9.7 / [APP-PROTOCOL.md](APP-PROTOCOL.md)를 기준으로 만든다.

### 9.7 앱 채널 프로토콜 v1 (플랫폼 중립)

> 전체 명세(필드·오류·views 형식)는 **[APP-PROTOCOL.md](APP-PROTOCOL.md)** 가 기준이다. 아래는 요약.

- **인증**: 모든 요청 `Authorization: Bearer <기기 토큰>`. 경로 `/m/v1/app/*`는 `client: 'app'` 기기만(아니면 403). 브리지의 토큰 검사·
  기기별 분당 60건·실패 10회 잠금·크기 상한(JSON 64KB, 업로드 12MB)을 그대로 쓴다. 공개 노출은 Funnel의 `/m` 경로 하나.
- **짝 맞추기**: `POST /m/p/<nonce>/app {"code":"123456"}` → `{ok, deviceId, deviceName, baseUrl, token}` / `403 {error:"wrong", attemptsLeft}` / `410 {error:"expired"|"burned"}`.
- **엔드포인트**(`/m/v1/app/` 아래):

| 메서드·경로 | 본문 / 쿼리 | 응답 |
|---|---|---|
| `GET capabilities` | – | `{protocol:1, features:["chat","cards","notices","share","stream","events"], views:[{name,version}]}` |
| `GET status` | – | `{protocol, assistant:{name,language,timezone}, lastSeq, serverTime}` |
| `GET events` | `after`(seq), `limit`(≤200) | `{events:[…], lastSeq}` |
| `GET stream` | 헤더 `Last-Event-ID` | `text/event-stream`: `event:<type>`, `id:<seq>`, `data:<이벤트 JSON>`; 25초마다 `: keepalive` |
| `POST messages` | `{text?, choice?, shared?, clientId?}` | `{seq}` (`clientId` 같으면 한 번만, `duplicate:true`) |
| `POST cards/:id` | `{decision:"approve"\|"deny"\|"edit"}` | `{state}` / 410 `gone` |
| `POST share` | 원본 바이트, `Content-Type`, `X-File-Name`(URL 인코딩) | `{seq}` |
| `GET me` · `POST rotate` · `POST unpair` | – | 기기 정보 / `{token}` / `{ok}` |
| `GET views/:name` | 뷰마다 다름 | `{view, version, data}` |

- **이벤트**(하나의 순서 있는 로그, `seq`는 늘기만 함, 최근 500개 보관): `message{role:"assistant"|"owner", text, choices?}`,
  `notice{text, choices?}`, `card{cardId, summary, effects[], effectLabels[], note?, expiresAt}`, `card_closed{cardId, state:"approved"|"denied"|"expired"|"closed"|"edit"}`.
  공통 필드 `type`, `seq`, `at`(ISO). 클라이언트는 **모르는 `type`은 건너뛴다**(새 서버와 옛 앱이 같이 돌도록). 재시작으로 기다리는 쪽이 없어진
  열린 카드는 시작 때 `expired`로 닫힌다.
- **버전·확장 지점**: `protocol` 정수(호환 안 되는 변경 때만 올림), 기능은 `capabilities.features`로 협상. **읽기 전용 화면(views)** 은
  능력 `app.views`(`AppViewRegistry.register({name, version, read(query)})`)로 다른 플러그인이 추가하고 `GET views/<name>`으로 나간다.
  M6에서 구현한 뷰: `today`(홈 요약), `usage`(모델·목적별 호출·비용·실패율, 일/주/월), `knowledge`(지식 문서 목록·본문·줄 고치기 —
  `POST views/knowledge/correct`, skill.knowledge가 등록), `approvals`(열린 카드), `improvements`(개선 기록), `health`(상태 점검),
  `spending`(월별 지출). 뷰의 쓰기는 `POST views/<name>/<action>`(주인 자신의 되돌릴 수 있는 수정)만, 보내기·결제·삭제는 확인 카드를 거친다.
- **구현 위치**: 서버 `src/channels/app/*`(로그·카드·라우트·뷰·공유), 브리지 쪽 `src/mobile/app-api.ts`(능력 `device.api` — 라우트·업로드·SSE),
  `src/mobile/app-routes.ts`(인증·앱 페어링·APK 링크). 채널은 브리지를 import하지 않고 `device.api` 능력만 쓴다.

## 10. 보안·개인정보

- **비밀은 macOS Keychain에만**(서비스 `ax-kit`). `security -i`에 표준입력으로 넣어 명령줄 인자·프로세스 목록에 안 남게 한다.
  플러그인은 manifest에 적은 이름만 읽을 수 있다(`scopedReader`). 모델은 비밀값을 절대 보지 않는다.
- 설정 파일·DB·로그에는 비밀 이름만. 로거는 토큰처럼 생긴 값과 `token/secret/password/api key` 필드를 쓰기 전에 가린다.
- `~/.ax-kit`은 700, 파일은 600.
- 텔레메트리 없음. 오류 보고도 사용자가 버튼으로 고를 때만.
- 민감 데이터는 사용자가 `sensitive`를 허락한 공급자·로컬 모델에만(§6).
- 감사 기록(audit)은 추가만: 도구 실행, 확인 카드 결과, 페어링·토큰 회전.
- 휴대폰 토큰 회전·폐기(§9.3), 디스코드 주인은 페어링 코드로만 바뀜.

## 11. 원본 AX에서 가져올 것 / 뺄 것 / 다시 짤 것

원본 코드는 **읽기만** 하고, 옮길 때는 새 경계에 맞춰 다시 쓴다(개인 이름·주소·계정·제품 문자열·KST 고정 금지).

| 원본 모듈 | 판정 | ax-kit 위치 | 메모 |
|---|---|---|---|
| `scheduler.ts` | 다시 짬 | `core/scheduler` | KST 고정 → 사용자 시간대, 시계 주입 **(뼈대 완료)** |
| `secrets.ts`, `exec.ts` | 다시 짬 | `core/secrets` | 서비스 이름 `ax-kit`, 이름 검증, 범위 제한 **(완료)** |
| `config.ts` | 다시 짬 | `core/config` | zod 스키마, 비밀 없음 **(완료)** |
| `db/`, `migrations/` | 다시 짬 | `core/store` | Postgres → SQLite, 플러그인별 마이그레이션 **(최소 완료)** |
| `llm/` (router, budget, circuit, sensitivity, usage) | 다시 짬 | `core/llm` | 공급자 2종 + 예산 **(완료)**; 계정 순환·구독 CLI·특정 중계 서비스 제외 |
| `events/registry, router` | 다시 짬 | `core/events` | 범용 버스만. 제품 이벤트 제외 **(완료)** |
| `act/`, `holds/`, `policy/priority`, `guard/` | 다시 짬 | `core/policy`, `core/tools` | P0~P4+위원회 → 효과 기반 확인 **(완료)**; M1: 도구별 `reject`(근거 없음 거절)·`uncertainty`(추정이면 확인 카드); 주입 감지·정지 스위치는 M2 |
| `discord/` (bot, cards, interactions, format, post) | 다시 짬 | `channels/discord` | 봇 1개. 페르소나·팀 공지·아바타 제외 **(최소 완료)** |
| `chief/` (chief, context, flow, ask-policy, resolve, rich, tools) | 다시 짬 | `skills/assistant` + `locale/` | 대화 루프의 핵심. 한국어 흐름 규칙은 언어팩으로 **(M1: 루프·도구·요약 기억·말투)** |
| `latte/` (proactive, open-loops, voice, catch-up, metrics, facts, attachments) | 다시 짬 | `skills/assistant` | 페르소나 이름 제거. 개발 요약(dev-digest/progress) 제외 |
| `latte/autoresearch, tuned`, `harness/` | 나중 | `skills/tuning` | M3, 기본 꺼짐 |
| `briefing/` (digest, render, changes, candidates, feedback) | 다시 짬 | `skills/briefing` | 팀·제품 섹션 제외 **(M1: 일정·중요 메일·할 일, 첫 브리핑)** |
| `google/` (oauth, client, mime, parse) | 다시 짬 | `connectors/google-*` | 사용자 자신의 OAuth 클라이언트. 앱 리뷰 수집 제외 **(M1: `connectors/google`, Calendar·Gmail)** |
| `ingest/` (gmail, calendar, sanitize, mask, runner) | 다시 짬 | 연결기 + `core/ingest` | slack·github·discord-dm 수집은 선택 |
| `mail/` (gate, grounding, reply-check, thread, pretriage) | 다시 짬 | `skills/mail` | 장애 대응(incident) 제외 |
| `classify/` | 다시 짬 | `skills/mail` | 메일 분류 규칙·학습 |
| `knowledge/`, `graph/` | 다시 짬 | `skills/memory` | 초기 사실(seed)·사서 데이터 제외, 출처·감쇠 유지 **(M2: 사실 기억·연락처 기억·`people.recall`)** |
| `assist/phone.ts`, `sms-filter.ts`, `sms-action.ts` | 다시 짬 | `mobile/` | 기기별 토큰·회전·페어링 추가, 한국어 스팸 규칙은 언어팩 **(M2 완료)** |
| `assist/spend, watch, followups, mail-drafts, memory, geo` | 다시 짬 | `skills/spending`, `skills/watch` + `connectors/web`, `skills/mail`, 지역팩 | 회사 경비 청구는 범용 `skills/expenses`로 **(M3 완료)** |
| `assist/kr-apis`, `transit/`, `news/`, `monitor/` | **기본** | `connectors/ko-life` + `skills/local-life` | 한국 생활 기본팩(날씨·미세먼지·장소·교통·택배·최저가), `ko`에서 기본 켬, 키는 사용자가 넣음 **(M2 1차 완료; 교통은 서울만)** |
| 일정 전날 준비, 이동시간 경고, 하루 마감, 밀린 답장, 연락처 기억, 음성 메모→할 일, 건강 리마인드 | 다시 짬 | `skills/day`(준비·이동·마감·밀린 답장·음성 메모·건강), `skills/memory`(연락처), Gmail `mail.awaiting` | **(M2 완료)** 하루 흐름은 한 스킬 안 기능별 파일, 기능마다 설정으로 끔 |
| 출장/여행 묶음, 구독/정기결제, 영수증/서류 정리, 지출/소비 패턴, 경비 청구 정리(AI·인프라 비용 포함) | 다시 짬 | `skills/trip`, `skills/spending`(구독 포함), `skills/receipts`, `skills/expenses` | **(M3 완료)** 회사명·계정·청구처·청구 규칙은 설정값/학습, 청구 메일은 초안까지, 발송은 `mail.send_draft`(`send`, 항상 승인) |
| `kakao/`, `assist/card-notice.ts` | 선택 플러그인 | `connectors/screen-chat`(`connector.kakao-desktop`) + `skills/chat-inbox` | macOS 손쉬운 사용으로 목록만 읽음(방 안 엶), 카드사 알림톡 → `money.notice`. 약관·계정 위험 고지 후 켬 **(M4 완료)** |
| `discordapp/` | 선택 플러그인 | `connectors/screen-chat`(`connector.discord-app`) | 셀프봇 아님(화면 읽기, 누르기·입력 없음)이지만 계정 정지 위험 고지 **(M4 완료)** |
| `desktop/`, `apple/` | 선택 | `connectors/macos-desktop`, `connectors/apple-reminders` | 손쉬운 사용 권한, M3 |
| `web/` (브라우저 위임, 확인 캡처, 장바구니) | 선택 | `connectors/browser` + `skills/browser` | Playwright 어댑터 기본, 외부 브라우저 에이전트 CLI는 어댑터; 로그인·결제·약관·캡차에서 멈추고 사람에게 넘김, 작업 맡기기는 `send` **(M4 완료)** |
| `life/` (쇼핑·예약·주문) | 선택 | `skills/errands` | M3. 자동 결제 한도 기능 없음 |
| `engineer/` | 일부 | `skills/dev-assist` | 사용자 저장소에서 작은 작업 → 초안 PR까지(머지 메서드 없음). 제품 출시·잠금 제외, 보호 경로·비밀 검사 **(M4 완료)** |
| `resilience/` (backoff, health, outage) | 일부 | `core/resilience` | 배포 감시 제외 |
| `daemon/` (wire, watchdog, readiness) | 다시 짬 | `app/`, `cli/` launchd | 제품용 체크포인트 제외 |
| `cli/` (launchd, connect-google, connect-models, config) | 다시 짬 | `cli/` | KPI·결제·Slack 연결 명령 제외 |
| `doctor/`, `audit.ts`, `log-sanitize.ts`, `retry.ts`, `dedupe/` | 다시 짬 | `cli/doctor`, `core/log`, `core/util` | |
| `notify*.ts` | 다시 짬 | `core/notify`(M1) | 알림 종류별 조용한 시간·상한·중복, `OwnerChannel` 위에 **(M1 완료)** |
| `improvement/`, `harness/` | 선택 | `skills/tuning` | 거절·수정한 카드 → 주 1회 규칙 제안 → 누르면 적용 → 1주 뒤 효과 측정 **(M4 완료)**; M5b: 실패·적체·알림·모델 신호, 효과 없으면 되돌림 제안, '개선 기록' 문서 |
| `sentinel/`, `advisories/` | 선택 후보 | – | 기본 꺼짐 |
| 회사 제품 모듈, `pg/` | **제외** | – | 특정 제품·결제대행 |
| `org/`, `teams/`, `engineer/`(batch·ai-review·daily-train) | **선택 플러그인 `company`** | `skills/company` | 설정 파일의 팀(팀장·팀원 모델 등급·담당 범위) → 접수 → 계획 → 실행 → 검토 → 하루 한 번 묶음 보고. 열린 일 상한·나이 상한·전용 예산·`approver_kind`, 개발 팀은 dev-assist 재사용(초안 PR까지) **(M5b 완료)** |
| `pm/`, `qa/`, `sre/`, `store/`, `cs/`, `kpi/`, `perf/`, `staffing/`, `council/`, `a2a/`, `backlog/`, `intel/`, `handoff/` | **제외** | – | 팀 종류는 설정으로 만든다. 제품별 팀·회의·출시 열차는 다시 짜지 않음 |
| `security/`, `ops/`, `dashboard/` | **제외** | – | 특정 서비스 점검·호스트 운영. 상태는 `/status`와 `doctor`로 |
| `prompts/`, `policy/*.yaml`, `knowledge/*` 데이터 | **제외** | `prompts/assistant/*` 새로 씀 | 개인 대화로 학습된 내용·상시 결정 복사 금지 |

## 12. 디렉터리 구조

```
bin/ax-kit.mjs                 CLI 진입(빌드 없이 tsx로 실행)
src/
  core/                        외부 계층 import 금지
    config/   schema.ts load.ts
    plugin/   types.ts host.ts
    events/   types.ts bus.ts
    scheduler/types.ts scheduler.ts next-run.ts clock.ts
    llm/      types.ts gateway.ts ledger.ts providers/{anthropic,openai-compatible}.ts
    secrets/  types.ts keychain.ts memory.ts scoped.ts
    policy/   types.ts confirm.ts
    tools/    types.ts registry.ts executor.ts
    conversation/ types.ts router.ts
    store/    types.ts sqlite.ts
    log/      types.ts console-logger.ts
    contracts/ calendar(read·write) · mail(read·draft·send) · todo · notify(owner channel·notifier)
    time/     date-spec(상대 날짜 → 실제 날짜, 코드 계산) · evidence(근거 인용 확인)
    notify/   quiet-notifier(조용한 시간·상한·중복·보류 큐)
  channels/discord/            discord.js는 여기서만
  channels/app/                (M6) 앱 채널: 이벤트 로그·확인 카드·라우트·views·공유 파일 (프로토콜 §9.7)
  core/hub/                    (M6) ChannelHub — 채널 여러 개(디스코드·앱)를 replier·confirmer·owner.channel 하나로
  connectors/google/           OAuth(루프백·PKCE) · Calendar · Gmail (M1), 답장 대기(M2), Drive(M3), Gmail 정리 · Docs · Sheets ·
                               Tasks · 주소록(M7, workspace-*.ts, 권한 안내 scope-help.ts)
  connectors/aside/            (M7) Aside CLI로 오너의 로그인된 브라우저에서 보기·하기(`web.agent`)
  connectors/ko-life/          (M2) 기상청·에어코리아·카카오 로컬·서울 교통·스마트택배·네이버 쇼핑, (M3) TAGO 버스(서울 밖)
  connectors/web/              (M3) 공개 페이지 읽기(사설·로컬 주소 거절, 2MB·15초 상한)
  connectors/local-files/      (M3) 사용자가 고른 폴더, 읽기 전용; connectors/google/drive*.ts (M3) Drive 폴더, drive.readonly;
                               (M5a) scan-*.ts·git.ts 처음 알아보기용 폴더 훑기(`connector.folder-scan`), Drive `recent`
  skills/<id>/                 greeting · assistant · calendar · mail · todo · briefing (M1) · memory · interview · day · local-life (M2) ·
                               spending · expenses · watch · receipts · trip · files (M3) ·
                               chat-inbox · browser · dev-assist · tuning (M4, 선택) · onboarding · knowledge (M5a) ·
                               docs · company (M5b, company는 선택) · routines · ways · workspace (M7)
  connectors/screen-chat/      (M4) ax-read.swift(읽기 전용 접근성 트리) · 카톡 목록·디스코드 화면 해석 · 미리보기 추적 · kakao.send(kmsg)
  connectors/browser/          (M4) Playwright·브라우저 에이전트 CLI 어댑터, 넘김 감지
  connectors/macos-ocr/        (M4) ocr.swift(Vision·PDFKit, 로컬)
  core/process/                (M4) 프로그램 실행·Swift 도우미 컴파일
  core/docs · core/switches · core/health   (M5b) 구조화 문서 저장소 · 만료 있는 정지 스위치·기능 차단기 · 상시 점검
  mobile/                      (M2) 기기·페어링·수신 서버·신호·인증번호·문자 할 일, files/(iOS 단축어·MacroDroid 파일·서명)
  app/                         조립(build.ts, plugins.ts)
  cli/                         main · setup · doctor · start · secret · launchd
test/                          src와 같은 구조
docs/                          ARCHITECTURE.md(이 문서) · DESIGN.md(하네스 규칙)
prompts/assistant/             system.md · program.md · tuned.md
```

## 13. 코딩 규칙

- **TypeScript strict** + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **파일 300줄 상한**(빈 줄·주석 제외) — `max-lines` lint 오류. 넘으면 책임을 나눈다.
- **의존성 방향**: §2 규칙을 `eslint.config.js`의 `no-restricted-imports`로 강제(core → 바깥 금지, 플러그인 계층끼리 금지,
  app → cli 금지, `discord.js`는 `channels`에서만).
- **SOLID**: 인터페이스는 쓰는 쪽 기준으로 작게(예: `SecretReader` ⊂ `SecretStore`), 구현은 생성자 주입, 기능 추가는 플러그인 추가로.
  플러그인은 구체 클래스가 아니라 `PluginContext`와 능력만 받는다.
- **주석**: 코드를 다시 말하는 주석 금지. "왜"(약관, 사고에서 배운 것, 보안 이유, 플랫폼 제약)만. 공개 인터페이스는 한 줄 설명.
- 코드 안의 문자열·식별자는 영어. 사용자에게 보이는 문장은 언어팩(`ko`, `en`)으로.
- 개인 정보·특정 제품 문자열 금지: 커밋 전 금지어 grep(목록은 저장소 밖 파일, pre-commit 훅은 M1).
- 시간은 항상 사용자 시간대 + 주입된 `Clock`. `Date.now()` 직접 호출은 core 구현 안에서만.

## 14. 테스트 전략

- **단위(vitest)**: core는 전부 가짜 시계·가짜 exec·가짜 fetch·`:memory:` SQLite로 실제 시간·네트워크·Keychain 없이.
- **계약 테스트**: 능력 인터페이스마다 공용 테스트 묶음(`describeCalendarSource(make)`)을 두고 실제 연결기와 가짜 구현이 둘 다 통과.
- **채널**: discord.js를 `DiscordPort` 뒤에 두고 가짜 포트로 메시지 → 라우터 → 답을 끝까지 검증.
- **정책**: `send/pay/delete`가 어떤 설정에서도 확인 없이 실행되지 않음, 확인할 곳이 없으면 거절 — 회귀 테스트로 고정.
- **대화 품질(M1~)**: 실제 대화에서 뽑은 평가 세트(로컬 DB에만) + 채점 기준(`prompts/assistant/program.md`).
- **수동 확인 목록**: 디스코드 봇 실제 응답, launchd 재시작, 휴대폰 파일 가져오기(iOS/Android 각 1회).
- CI 명령: `pnpm check` = `tsc --noEmit` + `eslint .` + `vitest run`.

## 15. 로드맵

| 단계 | 내용 | 끝났다는 기준 |
|---|---|---|
| **M0 뼈대** (이번) | core 인터페이스·최소 구현, 디스코드 "안녕" 응답, CLI setup/doctor/start, lint 계층 규칙 | `pnpm check` 통과, 실제 봇이 주인에게만 답함 |
| **M1 비서 핵심** (구현) | `skill.assistant`(LLM 대화 루프·도구 호출·확인 카드·흐름 규칙 ko·대화 요약 기억), 능력 계약(`core/contracts`), Google OAuth(자기 클라이언트·루프백·PKCE) + Calendar/Gmail 연결기, `skill.calendar`(근거 인용·상대 날짜 코드 계산·불확실하면 확인 카드), `skill.mail`(초안 → 승인 → 발송), `skill.todo`(리마인더), `skill.briefing`, `core/notify`(조용한 시간·상한·중복), 구독 CLI 공급자, `ax-kit service`(launchd), DM 페어링 | 설치 후 30분 안에 첫 브리핑, 일정 묻고 답하기, 메일 답장 초안 → 확인 후 발송 |
| **M2 휴대폰·기억·하루 흐름** | `bridge.mobile`(페어링·토큰 회전·iOS 서명 파일·MacroDroid 파일), Tailscale Funnel 안내, `skill.memory`(출처·감쇠), **연락처 기억**, 객관식 인터뷰, Drive·로컬 파일 연결기, **일정 전날 준비**(준비물·자료·장소 확인), **이동시간 경고**(위치+교통), **하루 마감**(오늘 한 일·내일 첫 일정·남은 할 일), **밀린 답장**(답 안 한 메일·메시지 모아 초안), **음성 메모 → 할 일**, **건강 리마인드**(걸음·물·약, 휴대폰 신호 기반), 한국 생활 기본팩 1차(날씨·장소·교통) | iOS·Android 실기기에서 위치·문자 수신, 단계 수 실측 — **코드·테스트 완료(2026-11-17), 서명은 이 맥에서 확인, 실기기 확인과 Drive·로컬 파일 연결기는 남음** |
| **M3 확장** — **코드·테스트 완료(2026-11-17)**: 지출 장부·구독·경비 청구·감시·영수증 보관함·여행 묶음·파일 연결기·정리 작업·TAGO·iOS 서명 대안·Funnel 점검. 남음: dev-assist, 카톡 PC·디스코드 앱·브라우저 선택 플러그인, 자기 조정 | `skill.watch`(가격·페이지, **최저가**), `skill.spending`(**지출/소비 패턴**, **구독/정기결제** 찾기·해지 알림), **영수증/서류 정리**(메일·사진 첨부 → 분류 보관), **경비 청구 정리**(회사 경비, AI·인프라 사용료 포함, 청구 메일 초안까지 — 보내기는 승인), **출장/여행 묶음**(항공·숙소·일정·이동 한 묶음), 한국 생활 기본팩 2차(택배 조회), `skill.dev-assist`(PR까지), 선택 플러그인: 카톡 PC·디스코드 앱 읽기·브라우저·심부름, 자기 조정 | 플러그인 켜고 끄기만으로 기능 추가·제거 |
| **M4 선택 플러그인** — **코드·테스트 완료(2026-11-17)** | 카톡 PC 읽기·디스코드 앱 화면 읽기(+대화 정리 스킬), 브라우저 위임, 개발 보조(초안 PR), 영수증 OCR, 자기 조정, 여행 D-1 목적지 날짜 날씨 | 모두 기본 꺼짐, 한국어 setup에서 위험 고지 후 켤지 물음 |
| **M5a 처음 알아보기·지식 문서** — **코드·테스트 완료(2026-11-18)** | setup 끝 동의 → 폴더·Drive·연결 기능 훑기, 오너 프로필·프로젝트 문서화, 확인 카드로 고치기, 사실 → 분야별 문서, 매일 증분 | 실계정·실기기 확인은 남음 |
| **M5b 회사 모드·지속 자기 개선** — **코드·테스트 완료(2026-11-18)** | 선택 `skill.company`, 구조화 문서(`knowledge.docs`), 만료 있는 정지·기능 차단기, 하루 알림 예산·저녁 묶음, 사실 끝 조건, 주간 개선 루프·상시 점검 | 모두 기본 꺼짐(문서·점검은 기본), AX 문제점 표의 각 항목에 대응 위치 |
| **M6 전용 Android 앱·앱 채널** — **코드·테스트·에뮬레이터 확인 완료(2026-11-18)** | (앱은 2026-11-19 재개발을 위해 제거) `channel.app`, `ChannelHub`(디스코드/앱/둘 다), `device.api`, `phone apk`·`phone pair --app`, doctor `app.connection` | 실기기 설치·알림 리스너·문자·지오펜스·헬스 커넥트 실측은 남음 |
| 클라이언트 앱 재개발 | 같은 프로토콜(§9.7) 기준 새 앱 | 2026-11-19 이전 앱 제거 |
| M5 나머지 | 제3자 플러그인 로딩·허락, Linux | 2026-11-18 판단: **보류**. 지금 쓰는 사람은 초대받은 소수(비공개 저장소)라 플러그인은 저장소 안 `src/app/plugins.ts` 등록 + `config.plugins.<id>.enabled`로 충분. 밖 코드 로딩은 서명·권한 화면·격리(별도 프로세스) 없이는 키체인·확인 정책을 우회할 수 있어, 최소 구현이라도 가치보다 위험이 크다. 외부 기여자가 생기면 다시 본다 |

### 15.1 M3에서 정한 것

- **지출**: 원문(`money.notice`) → 파서 목록(국내 카드사 12곳 + 메일 영수증, 배열이라 언어팩이 추가) → 카드번호 제거 → 환산(카드사가 찍은
  원화 우선, 없으면 설정 환율·`fxEstimated`) → 분류(사용자 학습 > 규칙 > 저가 모델(가맹점 이름만, `masked`) > 기타) → 장부(월별 kv).
  중복: 같은 원본 id, 카드 알림끼리 30분 안 같은 금액·가맹점, 메일 영수증과 카드 알림은 3일 안이면 한 건(`hasReceipt`).
- **해지·청구·삭제**: 구독 해지는 관리 주소 안내만. 청구 메일은 `mail.compose` 초안, 버튼 '보내기'도 `mail.send_draft`를 거쳐 승인 카드.
  감시·규칙·여행 구간 지우기와 기억 '이제 아니에요'는 `delete` 도구라 승인 카드.
- **보관함**: `~/.ax-kit/files/vault/<YYYY-MM>/…`, 디렉터리 700·파일 600(umask 때문에 chmod로 다시 맞춤), 경로는 루트 밖으로 못 나감.
- **파일**: 텍스트 종류만(기본 1MB), `.env`·키·`.ssh`·비밀번호·여권·통장 같은 이름은 고른 폴더 안이어도 안 읽음, 심볼릭 링크 안 따라감.
  색인은 kv 토큰 색인(문서 3000개 상한), 모델에 보내지 않음.
- **정리**: `retention.usageDays`(400)·`auditDays`(365)로 매일 04:10 오래된 사용량·감사 행 삭제. 기억은 주 1회 흐려지는 사실 2개까지 '아직 맞나요?'.
- **휴대폰**: 서명 실패 시 터미널이 단계별 대안을 자동 안내(재시도 → iCloud 링크 + 가져오기 질문, 연결 문자열은 휴대폰 페어링 페이지에만).
  `ax-kit phone template`(주소·토큰 없는 템플릿), `ax-kit phone funnel [--fix]`(단계별 점검, `--fix`는 /m 경로만 물어보고 연결).

### 15.2 M4에서 정한 것

- **화면 읽기**: 우리 Swift 도우미(`ax-read`)는 `trusted`·`dump`만 한다(실행·활성화·누르기·입력·스크롤 없음, 보안 입력칸 값은 안 읽음).
  카톡은 목록 첫 표/목록의 행(제목·미리보기·`Count Label` 배지), 디스코드는 창 제목(DM/채널/홈)·DM 링크(읽지 않음·멘션)·열린 화면의 메시지.
  첫 수집은 기준만 잡고 알리지 않음. 읽지 않음 > 0일 때만 새 줄, 0으로 바뀌면 '읽음' 줄(밀린 답장 지움). 메시지 본문은 로그에 안 남김.
- **대화 정리(`skill.chat-inbox`)**: 카드사 방 → `money.notice`(그 외 처리 없음) · 1:1 방 → 연락처에 "카카오톡 대화" 같은 코드 요약만 ·
  밀린 답장 매일 18:00(3시간 넘은 것, 7일 지나면 버림) · 날짜·시간 낱말이 있으면 모델(`sensitive`)이 근거 인용과 함께 일정 후보 →
  '일정에 넣기' 버튼이 `calendar.add_event`를 그 줄을 근거로 실행(근거·날짜 검사는 캘린더 도구가 다시 함). "내일" 같은 상대 날짜는
  본 날이 지나면 넣지 않고 날짜를 다시 묻는다.
- **카톡 보내기**: `kakao.send`(`send`, 항상 승인)는 kmsg가 있을 때만, kmsg에 저장된 로그인 정보가 있으면 거절, 카톡이 꺼져 있으면 거절
  (kmsg가 앱을 켜기 때문), 방은 `kmsg chats`의 제목과 정확히 같은 하나일 때 chat_id로만. 디스코드는 보내기 없음.
- **브라우저**: 페이지 글에 '비밀번호·카드번호·결제 수단·약관 동의·캡차'가 있거나 주소가 /login·/checkout이면 멈추고 `needs_human` +
  안내(맥 화면에서 직접, 밖이면 macOS 화면 공유). `browser.open_for_me`가 같은 프로필 창을 맥에 띄움. CLI 어댑터에는 고정 규칙 문구와
  `HANDOFF:`/`RESULT:` 줄 약속을 넘긴다. 앱 채널이 있고 Playwright 어댑터면 넘긴 페이지를 앱에서 직접 조작한다(`browser.live` 능력,
  `skill.browser`의 `LiveHub` → 앱 뷰 `browser-live`, APP-PROTOCOL.md §22): 같은 프로필의 헤드리스 페이지 하나, 오너 앱의 탭·글자만,
  친 글자는 로그·기록·모델에 안 감, '다 했어요'·15분 무조작·비상 정지에 닫힘, 비서는 조작 못 함.
- **개발 보조**: 작업 폴더 `~/.ax-kit/dev/<job>`(git worktree), 코더는 Claude Code(`--allowedTools` 편집만, Bash·웹·MCP 끔)·Codex(`--ignore-user-config`,
  workspace-write)·API(파일 통째 교체, 경로 검사). 테스트는 ax-kit이 돌리고 결과 끝부분을 PR 본문에. 보호 경로(.github/workflows, .env, 키)·
  비밀 모양 문자열이 바뀌면 거절. 푸시는 토큰을 환경변수 extraheader로만(명령줄·저장소 설정에 안 남김), `--force` 없음, 초안 PR만.
- **OCR**: PDF는 글자층이 있으면 그대로, 없으면 쪽을 그려 Vision으로(기본 10쪽, 25MB). 이 맥에서 한글 영수증 사진·글자층 PDF·스캔 PDF 확인,
  첫 호출은 모델 적재로 약 25초. 메일 첨부 영수증에 금액이 없으면 OCR로 채우고, `receipts.read_file`은 보관함 안 파일만.
- **자기 조정**: 알림 종류 14일 거절 2번 → 끄기, 방의 일정 제안 30일 거절 3번 → 그 방 끄기, 같은 낱말이 든 가맹점 2곳 이상을 같은 분류로
  고침 → 낱말 규칙. 주 1회 최대 3개, 누를 때만 적용, 1주 뒤 '주 N회 → M회' 효과 보고, `tuning.undo`로 되돌림.
- **여행 D-1 날씨**: 숙소의 인쇄된 체크인 날짜(목적지 현지), 없으면 여행 첫날의 예보. 예보 범위(기상청 단기예보 약 3일) 밖이거나
  `forecast`가 없는 날씨 출처면 날씨 줄을 빼고, 오늘 날씨로 대신하지 않는다.

### 15.3 M5a에서 정한 것

- **흐름**: `ax-kit setup` 마지막 질문에서 동의(지금/나중에/안 함)와 폴더를 고른다(있는 것만 제안: Documents·Desktop·Downloads·
  projects·dev 등, 번호로 빼고 경로로 더함) → `plugins["skill.onboarding"]`에 `folders`·`drive`·`signals`·`consentAt` 저장.
  데몬이 `app.started`에서 첫 훑기를 백그라운드로 시작하고 단계마다 디스코드로 진행률을 알린다. "알아보기 멈춰/계속/상태/다시
  알아보기"로 조절, 재시작하면 이어서 한다. 매일 `dailyAt`(04:30)에 바뀐 것만 다시 본다(파일별 `수정일|크기` 도장 캐시).
- **수집 경계**: 폴더는 `connector.folder-scan`(`files.scan`): 파일 메타 전체 + 글 종류만 앞부분, 민감 이름(§15.1 규칙)은 메타도
  안 남김, 심볼릭 링크 안 따라감, `node_modules`·빌드 폴더 건너뜀, 2만 항목·깊이 8 상한. git 저장소는 안을 나열하지 않고
  README·최근 커밋 제목(작성자 없음)·언어 구성만, git은 `-c core.fsmonitor=false -c core.hooksPath=/dev/null`로 저장소 설정이 프로그램을
  못 띄우게. Drive는 `FileSource.recent`(내 파일, 최근 수정순, 범위는 기존 `drive.readonly`). 연결 기능 신호는 수집기 목록
  (메일 보낸 사람 이름·제목, 일정 제목, 할 일, 대화방 **이름**만, 기억) — 수집기를 배열에 더해 넓힌다.
- **모델에 보내는 것**: 파일별 요약은 코드가 이메일·전화·긴 숫자·토큰을 가린 뒤 `fast`·`masked`, 한 번에 최대 60개
  (`maxSummariesPerRun`). 프로필 종합은 요약·통계·신호 목록으로 `standard`·`sensitive` 1회. 모델이 낸 줄은 근거 id(F·M·C…)가
  하나도 없으면 코드가 버리고, id를 경로·"Drive/문서"·"mail" 같은 출처로 바꿔 줄마다 붙인다. 경로가 없거나 예산을 넘으면
  저장소·폴더 통계만으로 코드가 프로필을 만든다(단, 모델이 쓴 프로필을 코드 대비책이 덮지는 않음). 매일 돌 때 입력 지문이
  같으면 종합 호출을 건너뛴다. 진행 알림은 단계 시작마다 한 줄 + 끝 알림(알림기 종류별 시간당 상한 때문).
  "3번 출구" 같은 일반 대화를 고침으로 오해하지 않게, 고침은 [고칠 줄 있어요]를 누른 뒤 6시간 안에만 받는다('N 삭제'는 언제나).
- **지식 문서(`skill.knowledge`)**: `~/.ax-kit/knowledge/` 아래 `README.md`(목차) · `프로필.md` · `프로젝트/<이름>.md` ·
  `분야/<분야>.md` · `변경기록.md`(최신이 위). 줄 id = 영역·주제·키 해시, 같은 id면 새 줄이 대체, 출처 순위
  `correction` > 나머지(고친 줄과 '삭제' 표시는 다음 훑기가 못 덮음). 기억 스킬의 사실은 매일·시작 시 분야로 분류(저가 모델
  1회, `masked`, 캐시, 실패 시 낱말 규칙)해 분야 문서로. 내용이 같으면 파일을 다시 쓰지 않고(갱신 시각 줄도 그대로), 디렉터리 700·파일 600.
- **확인 카드**: 첫 훑기 뒤 `owner.review`(인터뷰 스킬 제공)로 "제가 이해한 당신" 번호 목록 + [다 맞아요]/[고칠 줄 있어요].
  "2 회사는 ○○예요"·"3 삭제"로 고치면 `review.answer` 이벤트 → 지식 문서가 `correction`으로 반영, 같은 말이 인터뷰 사실
  (`review:<카드>:<줄>` ref, 반감기 365일)로도 저장된다.
- **대화**: 비서 프롬프트에 `knowledge.profile` 요약(600자 이하)을 항상 넣고, 자세한 건 `knowledge.search`·`knowledge.read` 도구로.

### 15.4 M5b에서 정한 것 (회사 모드·자기 개선)

출발점은 [AX 문제점 정리](AX-문제점-2026-11-18.md). 원본의 숫자(작업 101/104개가 하루 넘게 멈춤, 봇 승인 90%, 팀 글 하루 940건,
정지 스위치 27일 방치, 자기 개선 적용 715건·측정 0)를 막는 장치를 **기능보다 먼저** 넣었다.

- **회사 모드(`skills/company`, 선택)**: `plugins["skill.company"].teams[]`에 팀(id·이름·역할·담당 낱말·팀장/팀원 모델 등급·민감도·
  `kind: general|dev`·저장소). 접수는 대화 접두어(`회사: …`, `@팀id`), 도구 `company.submit`, 이벤트 `company.intake`, 선택 메일 검색.
  메일·이벤트로 온 일은 **데이터**라 `awaiting_accept`로 두고 저녁 보고의 버튼으로 주인이 받아야 시작한다.
  흐름: 팀장 계획(JSON, 단계 ≤4) → 팀원 단계 실행 → 팀장 검토(되돌림 1번, 넘으면 실패) → 완료. 한 번에 한 일만, 검토 > 실행 > 대기 순서(끝내고 시작).
  - 상한: 열린 일 6·팀당 2(대기 확인 포함), 72시간 안 움직이면 자동 닫힘, 결재 대기 7일이면 닫힘 — 닫힌 것은 저녁 보고에 한 줄.
  - 승인: `ApprovalRecord.approverKind = user | agent | policy`(`core/policy/approval.ts`). `send/pay/delete`(출시=send)는 `user`만,
    `recordApproval`이 봇 승인을 던진다. 회사 모드는 보내기·결제·삭제를 직접 하지 않고, 개발 팀의 초안 PR은 `dev.open_pr`(send)라 확인 카드.
  - 보고: 정기 글은 하루 한 번 `company.report` 하나(팀별 묶음, 받기 버튼 ≤5). 즉시 글은 결재 카드(`company.decision`)뿐.
  - 예산: `dailyUsd`(기본 $0.3)는 `core.usage`로 `company.*` 목적만 합산해 비서 예산과 따로. 넘으면 그날은 대기.
  - 지식: 팀마다 `company:team:<id>`(팀 문서)·`company:decisions:<id>`(결정 기록, 작성자 종류 포함)·`company:changelog:<id>`(변경 기록).
    회사 정보 `company:about|products|policies`는 첫 실행 때 질문 1번 → `company.profile` 도구로 저장(작성자 `user`).
  - 자기 개선이 `company.limits`를 **줄이는 쪽으로만** 조정할 수 있다(`effectiveLimits`는 설정값을 넘지 못함).
- **구조화 문서(`core/docs`, `knowledge.docs`)**: 문서 = 현재 본문 + 날짜 붙은 항목(작성자 `user|agent|policy`, 출처) + `basedOnFacts`.
  정답 저장소는 이것 하나, 채팅 카드·마크다운은 보기(`renderDoc`). 근거 사실이 끝나면(`memory.fact_expired`) 문서에 '다시 확인' 표시 +
  알림 한 번. `skill.docs`가 `knowledge.docs`·`knowledge.doc_show`·`knowledge.doc_verify` 도구를 주고, 한 시간마다 M5a 지식 폴더 안
  `~/.ax-kit/knowledge/docs/`에 마크다운 보기를 쓴다(바뀐 파일만, 700/600 — M5a 빌더는 자기가 쓴 파일만 지우므로 겹치지 않음). (M5a의 프로필·프로젝트 지식
  `knowledge.profile/write`와는 다른 능력 — 프로필 줄은 사실 기반 보기, 이 문서는 팀·결정·변경 기록용.)
- **사실 끝 조건**: `RememberInput.validUntil`(YYYY-MM-DD)·`untilEvent`("출시"). "출시 전이라·이번 주·당분간" 같은 말에 끝이 없으면
  `askEnd`로 되묻는다. 매일 08:50 지난 사실을 끝냄, `memory.event_happened`("출시했어")가 그 일에 걸린 사실을 끝냄. 끝난 사실은 기억에서
  안 꺼내고 주간 '아직 맞나요?'에 먼저 나온다.
- **정지 스위치·기능 차단기(`core/switches`)**: 정지에는 이유·주체·끝(최대 30일)이 필수, 끝나기 하루 전 알림. 같은 기능이 같은 이유로
  5번 연달아 실패하면 24시간 자동 정지 + 알림 한 번(`core.feature-health`). 전용 표 `feature_pauses/failures/runs`(범용 kv 아님).
- **알림 예산**: 급하지 않은 알림은 하루 20건(`notify.dailyBudget`), 넘으면 저녁 `digestAt`(20:00) 한 통으로. 시간당 종류별 상한·하루 예산·
  종류별 통계는 DB에 있어 재시작해도 이어진다. 모델 실패는 `llm_failures`(로그인 만료·한도·시간 초과 분류), `core.usage`로 목적별 집계.
- **주간 자기 개선(`skills/tuning`)**: 신호(카드 거절·수정, 기능 실패, 정지, 적체, 알림 양·예산 초과일, 모델 실패율, 끝난 사실, 점검 결과) →
  측정 지표를 미리 정할 수 있는 개선안만 최대 3개(숫자 근거) → 누르면 적용 → 1주 뒤 같은 지표로 효과 → 효과 없으면 되돌리기 제안 →
  모두 '개선 기록'(`tuning:improvements`) 문서에 누적.
- **상시 점검(`core/health`)**: 오래 켜진/자동 정지, 알림 과다, 다시 확인할·오래된 문서, 끝난 사실, 회사 적체(만든 것 대비 끝낸 것),
  실행 코드의 미커밋 변경. 주간 보고의 '점검' 칸과 `ax-kit doctor`(DB를 직접 읽음)가 같은 검사를 쓴다.

### 15.5 M6에서 정한 것

- **채널 선택**: `config.channel = 'discord' | 'app' | 'both'`(기본 `discord`, 옛 설정 호환). `app`이면 `owner.discordUserId`가 없어도 되고
  디스코드 토큰 점검도 doctor에서 빠진다. 앱을 고르면 `bridge.mobile`은 항상 켜진다.
- **둘 다**: 답은 메시지가 온 채널로만, 알림은 두 곳 모두(한쪽 실패는 무시, 둘 다 실패면 notifier가 실패 처리), 카드는 두 곳에 뜨고
  먼저 누른 쪽이 결정 — 다른 쪽 카드는 "다른 곳에서 처리했어요"로 닫힌다.
- **보안 경계**: 앱 토큰만 대화·카드 결정 가능(신호 파일 토큰은 403). 공유 파일 이름은 경로 문자 제거 후 inbox 안에만, `wx`로 덮어쓰기 없음.
  APK 링크는 30분, 서명 키 비밀번호는 Keychain에만.
- **실기기 남은 확인**: 알림 리스너(카드사 앱 실제 문구), SMS 리시버(삼성 메시지), 근접 경보 배터리 영향, 헬스 커넥트 권한 흐름,
  Funnel 위 SSE 장시간 유지·도즈 모드에서 포그라운드 서비스 유지, 실제 설치 단계 수.
- **먼저 말하기 판단(2026-11-18)**: `skill.day`의 `situational`(기본 꺼짐)이 켜지면 준비·마감 카드 전에 fast 모델이 JSON으로
  "맞춤 한 줄 / 카드만 / 침묵"을 고른다. 빈말은 코드가 지우고, 판단 실패면 원래 카드 그대로. 계기 `nudges.beforeEvent·midday·spend`도
  전부 기본 꺼짐, 하루 4·시간당 1(설정 가능, 카운터는 kv라 재시작 유지), 판단한 순간은 다시 판단하지 않는다(실패도 무전송).
- **문자 속 약속**: 브리지가 코드·카드 승인·스팸을 뺀 문자만 `phone.sms`로 내보내고, `skill.chat-inbox`의 `sms: true`(기본 꺼짐)일 때
  같은 근거 인용·DateSpec·중복·확인 카드 흐름에 태운다. 문자는 연락처·밀린 답장으로 가지 않는다.
- **브라우저 인증 자동 처리**: `skill.browser`의 `autoAuth`(기본 꺼짐, `sites` 허용 목록만). 오너가 승인한 `browser.task` 실행에만
  `BrowserTask.auth`가 붙고, 그 작업 시작 뒤 도착한 문자 인증번호(10분 보관)·그 사이트 자신의 메일 코드/링크만 넣는다. 금융·통신 사이트와
  이체·개통 같은 단계는 확인 카드, 결제·캡차·약관 화면은 그대로 사람에게. 넣은 코드는 페이지 글에서 가려 모델·로그로 안 간다.
  휴대폰 본인확인(번호·생년 입력)은 하지 않는다. CLI 어댑터는 `auth`를 무시(고정 규칙 그대로).

### 15.6 M7에서 정한 것 (2026-11-20)

- **길 찾기(`skill.ways`, `connector.aside`)**: 오너가 말한 일을 하는 방법을 스스로 찾는다 — 이미 있는 도구 → 오너의 브라우저(Aside CLI)
  → 필요한 접근을 한 번 묻기. 특정 사이트를 코드에 넣지 않는다: 오너가 "이 주소는 회사 관리 툴이야"라고 말하면 `ways.remember_site`로
  기억하고, 잘 된 절차는 다음 비슷한 요청의 출발점이 된다. 읽기는 `web.look`(read), 바꾸기는 `web.do`(send, 사는 말이 있으면 pay 카드).
- **루틴(`skill.routines`)**: 오너의 반복 지시와 봇의 후속 확인. 지운 루틴은 그 자리에서 스케줄러에서도 빠진다(`Scheduler.remove`).
- **메일**: 도착 10분마다 분류(중요·보통·낮음), 제안은 R15 주제 카드 하나씩. 할 일 카드는 회사 모드가 있으면 "팀에 맡기기" —
  `company.intake`(`approvedByOwner`)로 오너가 허락한 일로 바로 큐에. Gmail 정리는 `gmail.modify`를 고른 경우만, 광고 메일 보관은
  요약마다 카드 한 장, "앞으로는 알아서"는 한 카테고리·회사 도메인·발신자 범위만(전체 메일 규칙 없음).
- **Google 문서·시트·Tasks·주소록**: 각각 선택 권한, 범위는 좁게(새 문서는 `drive.file`, 읽기는 `documents.readonly`·`spreadsheets.readonly`,
  고치기는 고른 경우만). 읽은 내용은 데이터 표시와 함께, 시트 쓰기는 `RAW`(수식 실행 없음). Tasks가 켜지면 `skill.todo`가 같은 도구로 그 위에서 돈다.
- **파일**: `fs.watch` 변경 기록(`files.changes`), Spotlight 찾기(`files.find`), 앱으로 보내기(`files.share_to_app`, 내용·확장자 일치 검사,
  거절 이유는 오너 언어로). 앱 파일은 30일·1GB(오래된 것부터).
- **브라우저 넘김과 이어 하기**: 실행은 로그인·캡차·약관·결제·마지막 버튼에서 멈춘다. 오너가 마치고 "계속"이라 하면 같은 프로필로 이어 한다.
  마지막 버튼은 그 이름을 돌려주고, 오너가 허락하면 `approvedButton`으로 그 하나만 누른다 — 늘 그 실행 카드에서(자동 규칙 없음), 결제 버튼은 절대.
  앱 채널이 있으면 멈춘 페이지를 앱에서 직접 조작한다(`browser.live`, APP-PROTOCOL.md §22).

### 15.7 맥 확장 (2026-11-23)

- **다른 맥 앱 조작(`connector.mac-apps`, 선택)**: Swift 도우미 `ax-control`(손쉬운 사용 API, `~/.ax-kit/bin`에 첫 사용 때 컴파일).
  명령은 `trusted`·`apps`·`window`(초점 창, 깊이·개수 상한, 비밀번호 칸 값은 비움, `--redact 1`이면 모든 값 비움)·`selected`·`activate`·
  `press`/`set`(`--target` JSON 단계 `[{role,title?}]`, 각 단계는 앞 단계 안의 요소와 맞춤, 두 개 이상 맞으면 거절)·`menu`(`--items`).
  도구는 `mac.apps`·`mac.read_window`·`mac.selected_text`(read, 화면 내용은 `<data>`로 감쌈)와 `mac.act`(write, 누르는 이름에 따라
  send·delete·pay 추가). 정책은 코드에: `mac.act`는 늘 카드(불확실성 메모로 `confirmWrites`와 "앞으로 그냥" 규칙을 모두 건너뜀),
  이번 메시지(`grounding[0]`)에 오너의 말이 있어야 하고 대화에서 온 호출만, 은행·결제·증권·지갑·비밀번호 관리·키체인은 읽기만
  (비밀번호 관리 앱은 값도 안 읽음), 비밀번호 칸(`AXSecureTextField`)과 비밀번호처럼 보이는 칸에는 입력하지 않음, 터미널·시스템 설정은
  강한 경고 카드와 줄바꿈 입력 거절. 승인 뒤 실제 앱(번들 id)으로 한 번 더 검사한다. 앱을 실행하지는 않는다.
- **미리 알림 동기화(`connector.apple-reminders`, 선택)**: Swift 도우미 `ax-reminders`(EventKit, 사용 설명 Info.plist를 바이너리에 넣음 —
  `SwiftHelperSpec.infoPlistPath`). 명령은 `status`·`request`·`lists`·`reminders`(`--list`·`--since`·`--done-since`)·`create`·`complete`·
  `update`. 지우기와 알람 넣기는 없다. 능력 `todo.sync`(`TodoSyncBackend`: list·add·update, 항목마다 `updatedAt`).
  `skill.todo`는 `source: 'synced'`일 때 이 맥의 목록을 그대로 쓰고 10분마다(`todo.sync` 작업, `todo.list`는 30초에 한 번까지) 맞춘다:
  id 짝(`sync-state`), 양쪽이 고쳤으면 더 나중 쪽, 한쪽에서 사라졌다고 다른 쪽을 지우지 않음(미리 알림에서 사라지면 `note` 표시, 여기서
  지우면 미리 알림은 두고 그쪽에서 바뀔 때까지 무시), 빈 목록이 오면 읽기 실패로 보고 표시하지 않음. 목록 선택은
  `plugins["skill.todo"].source`(`local`·`google-tasks`·`apple-reminders`), 정하지 않으면 예전처럼 Google Tasks가 먼저.
- 앱 프로토콜에는 새 것이 없다(작업 목록에 `todo.sync`, `mac.act` 카드는 보통 카드).

## 16. 정해야 할 것

1. 이름(ax-kit은 가칭)과 기본 비서 이름 예시
2. 라이선스: MIT / Apache-2.0 / AGPL / 소스 공개(비상업)
3. 배포: npm 공개 패키지(`npx`) / GitHub 저장소 clone / 초대한 사람만
4. 휴대폰 통로 기본값: Tailscale Funnel(편의, 권장) / 사설망만(보안)
5. ~~구독 CLI 공급자~~ → **넣음**(2026-11-17, 약관·한도는 사용자 책임 안내)
6. ~~카톡 PC·디스코드 앱 화면 읽기~~ → **공식 선택 플러그인**(2026-11-17)
7. ~~한국 생활 지역팩~~ → **기본 포함**(2026-11-17)
8. 기본 언어: 한국어 먼저 + 영어 / 둘 다 동시
