# 앱 채널 프로토콜 v1

ax-kit 서버(맥)와 앱 클라이언트(Android 앱 M6, 데스크톱 앱 M7)가 쓰는 하나의 HTTP 프로토콜. 플랫폼 중립이며, 서버 구현은
`src/channels/app/*`(채팅·카드·views)과 `src/mobile/app-api.ts`·`src/mobile/app-routes.ts`(인증·라우팅·SSE)에 있다.
형식을 바꾸면 이 문서를 같은 커밋에서 고친다. 요약은 ARCHITECTURE.md §9.7.

## 1. 주소와 인증

- 기본 주소(`baseUrl`): Tailscale Funnel 공개 주소(`https://<mac>.ts.net`) 또는 사설망 주소(`http://100.x.y.z:47617`, `http://192.168.x.y:47617`).
  클라이언트는 `https` 또는 **사설 주소의 `http`** 만 받는다.
- 모든 앱 요청: `Authorization: Bearer <기기 토큰>`. 경로 `/m/v1/app/*`는 **앱으로 짝지은 기기(`client: "app"`)** 만 쓸 수 있다
  (MacroDroid·단축어 파일 토큰은 `403 {"error":"not_app"}`).
- 상한: 기기별 분당 60요청(넘으면 429), 잘못된 요청 10번이면 토큰 잠금(423), JSON 본문 64KB(413), 업로드 12MB.
- 응답은 항상 JSON `{"ok": true|false, ...}`(스트림 제외). 오류: 400 `shape|json|query`, 401 토큰 없음/틀림, 403 `not_app`,
  404 없는 경로·뷰, 410 지난 카드·만료된 짝 맞추기, 429, 503.

- **이 맥 전용 연결(데스크톱 앱, 짝 맞추기 없음)** — 서버가 시작할 때마다 새 토큰을 로컬 토큰 파일에 쓴다(폴더 700, 파일 600, 원자적 교체):
  ax-hq는 `~/.ax-hq/desktop.token`, ax-kit는 `~/.ax-kit/desktop.token`. 내용 `{"v":1,"baseUrl":"http://127.0.0.1:47617","token":"…","issuedAt":"…"}`.
  이 토큰은 **loopback(127.0.0.1·::1)에서 온 요청만** 받는다(그 밖은 `403 {"error":"not_local"}`). ax-hq 어댑터는 추가로 `Host`가
  `127.0.0.1|localhost|[::1]:<port>`가 아니면 `403 host`, `Origin`이 있으면 Tauri 출처(`tauri://localhost`, `http(s)://tauri.localhost`)만 받는다.
  앱마다 자기 파일만 읽는다(D2): **ax-kit 데스크톱 앱은 `~/.ax-kit/desktop.token`(또는 `AXKIT_TOKEN_FILE`)**, AX(ax-hq) 데스크톱 앱은 `~/.ax-hq/desktop.token`. 한 앱이 두 파일을 다 읽지 않는다. 401이 오면 파일을 다시 읽는다(서버 재시작 = 토큰 회전). 로컬 토큰의 요청 상한은 분당 240(폰 토큰은 60).
  `GET me`·`POST rotate`·`POST unpair`는 로컬 토큰에 대해 `{ok:true, local:true}`만 돌려준다(회전은 재시작이 한다).
- **폰(iOS·Android)** — §2 짝 맞추기로 받은 기기 토큰만. 로컬 토큰은 폰 주소에서 쓸 수 없다.
  - **외부 주소 = Cloudflare 터널 + Access 서비스 토큰**: `https://<폰용 공개 주소>`(ax-hq 설정 `desktopApp.publicUrl`) → 터널 → 맥의 폰용
    리스너 `127.0.0.1:47618`(데스크톱용 47617과 따로). 모든 요청에 `CF-Access-Client-Id`·`CF-Access-Client-Secret` 헤더(Access 서비스 토큰,
    앱이 Keychain/Keystore에 보관, 짝 맞추기와 별도로 오너가 앱 설정에 넣음)와 `Authorization: Bearer <기기 토큰>`을 함께 보낸다.
    Access 검증은 Cloudflare가 하고, 서버는 기기 토큰만 검사한다(터널을 거친 요청에는 `Cf-Access-Jwt-Assertion`이 붙어 온다).
  - QR의 `u`는 이 공개 주소다. ax-hq `ax app pair`의 QR에는 Access 서비스 토큰도 실린다:
    `axkit://pair?u=<공개 주소>&n=<nonce>&c=<6자리>&ci=<CF-Access-Client-Id>&cs=<CF-Access-Client-Secret>`(모두 URL 인코딩).
    앱은 `ci`·`cs`를 Keychain에 두고 모든 요청 헤더에 붙인다. QR PNG는 600 권한 파일로만 만들고, 링크·값은 화면·로그에 쓰지 않는다. 폰용 리스너도 같은 상한(분당 60요청, 잘못된 요청 10번이면 잠금, JSON 64KB, 업로드 12MB)을 지킨다.

## 2. 짝 맞추기

1. 맥에서 `ax-kit phone pair --app [--platform desktop|ios|android, 기본 android] [--name <이름>]`(QR과 `링크: axkit://pair?…` 한 줄 출력) (ax-hq: `ax app pair [--name <이름>] [--platform ios|android]`, QR PNG 파일 경로와 링크 한 줄을 출력) → QR: `axkit://pair?u=<baseUrl URL 인코딩>&n=<nonce>&c=<6자리>`. 1회용, 10분.
2. 클라이언트: `POST {baseUrl}/m/p/<nonce>/app` 본문 `{"code":"123456"}`(인증 헤더 없음)
   - 200 `{"ok":true,"deviceId":"d_…","deviceName":"…","baseUrl":"…","token":"…"}` — 토큰은 OS 보안 저장소에만(Android Keystore, macOS Keychain…)
   - 403 `{"ok":false,"error":"wrong","attemptsLeft":n}` · 410 `{"error":"expired"|"burned"}`(5번 틀리면 폐기)
3. `GET me` → `{deviceId,name,rotatedAt,createdAt}` · `POST rotate` → `{token}`(이전 토큰 7일 유효, 80일마다 권장) · `POST unpair` → 서버에서 즉시 폐기.

## 3. 엔드포인트 (`{baseUrl}/m/v1/app/` 아래)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET capabilities` | – | `{protocol:1, features:[…], views:[{name,version,actions:[…]}]}` |
| `GET status` | – | `{protocol, assistant:{name,language,timezone}, serverId, lastSeq, serverTime}` (`serverId`: 설치마다 고정된 id — 주소가 바뀌어도 같은 맥) |
| `GET events` | `?after=<seq>&limit=<1..200, 기본 100>` | `{events:[Event…], lastSeq, oldestSeq}` (seq 오름차순, `oldestSeq` = 서버가 아직 가진 가장 오래된 seq, 비었으면 0) |
| `GET stream` | 헤더 `Last-Event-ID: <seq>` | SSE: 놓친 이벤트를 먼저 보내고 실시간으로 이어감 |
| `POST messages` | `{text?, choice?, shared?, clientId?}` | `{seq}` · 같은 `clientId` 재전송은 `{seq, duplicate:true}` |
| `POST cards/<cardId>` | `{decision:"approve"\|"deny"\|"edit"}` | `{state}` · 이미 끝난 카드 410 `gone` |
| `POST share` | 원본 바이트, `Content-Type`, `X-File-Name`(URL 인코딩) | `{seq}` |
| `GET views/<name>` | 뷰별 쿼리 | `{view, version, data}` |
| `POST views/<name>/<action>` | 뷰별 JSON | `{view, action, data}` |

- `features`: `chat`, `cards`, `notices`, `share`, `stream`, `events`, `views`(+ ax-kit도 APNs 키가 있으면 `push`, §7.7). 클라이언트는 목록에 없는 기능의 화면을 숨긴다.
- ax-kit도 `GET files/<id>`(같은 토큰, 원본 바이트)와 이벤트 `attachments[]`·`imageUrl`(§7.5)을 지원한다.
- `messages`: `text`(최대 8000자) 또는 `choice`(이전 메시지 `choices[].id`) 중 하나. `shared:true`면 공유 시트에서 온 글·링크.
- 신호(위치·문자·알림·걸음·배터리)는 앱 채널이 아니라 기존 `POST /m/v1/ingest`(같은 토큰, 본문 `{"v":1,"ts":<보낸 시각>,"items":[{kind,…,"at":<발생 시각>}]}`,
  `items[].at`은 48시간 이내) — ARCHITECTURE.md §9.4.

### 3.1 스트림(SSE)

```
event: message
id: 42
data: {"type":"message","seq":42,"at":"2026-11-18T06:19:46.209Z","role":"assistant","text":"…"}

: keepalive          ← 25초마다
```

연결이 끊기면 마지막으로 받은 `seq`를 `Last-Event-ID`로 다시 연결한다(2초부터 최대 60초 백오프). 기기당 동시 스트림 3개까지.

## 4. 이벤트

하나의 순서 있는 로그(서버가 최근 1000개 보관, 답을 기다리는 카드는 그보다 오래돼도 남김). 공통: `type`, `seq`(늘기만 함), `at`(ISO 8601).

| type | 필드 |
|---|---|
| `message` | `role: "assistant"\|"owner"`, `text`, `choices?: [{id,label}]`, `live?: {view:"browser-live", reason, url?}`(§22, 비서 답에만) |
| `notice` | `text`, `choices?`, `kind?`, `live?: {view:"browser-live", reason, url?}` — 브리핑·알림(조용한 시간·하루 예산은 서버가 이미 적용). `kind`는 알림 종류(`browser.task`, `dev.job`… 저녁 묶음은 `digest`, 밤사이 묶음은 `overnight`), `live`는 백그라운드 일이 넘긴 페이지(§22·§28, '브라우저 화면 열기' 버튼) |
| `card` | `cardId`, `summary`, `effects: ["read"\|"write"\|"send"\|"pay"\|"delete"]`, `effectLabels: [사용자 언어]`, `note?`, `expiresAt` |
| `card_closed` | `cardId`, `state: "approved"\|"denied"\|"expired"\|"closed"\|"edit"`, `answer?`(§7.3 직접 답하기로 닫힌 경우 오너가 쓴 글) |

공통 선택 필드(§7, 모르는 필드는 무시): `channel?`(방 id, §7.2), `author?: {id, name, avatar?}`(팀 봇), `links?: [{label,url}]`(원격 화면·미리보기),
`attachments?: [{id, name, contentType, size, url}]`(`url`은 `files/<id>` 상대 경로, 같은 토큰으로 받음). `card`에는 `options?`·`selects?`·`form?`(§7.3).

- **`activity`(기능 `activity`, 로그 밖)**: 비서가 오너의 말을 처리하는 동안만 스트림으로 온다. `seq`·`id`가 없고 다시 보내 주지 않는다
  (`Last-Event-ID`는 그대로 로그의 seq). 모양: `{type:"activity", channel?, state:"thinking"|"working"|"idle", step?, at}`.
  - `thinking` = 말을 받고 생각하는 중, `working` = 도구를 쓰는 중(`step`은 쉬운 말: "메일 보는 중", "웹에서 찾아보는 중" — 도구 이름은 안 옴),
    `idle` = 끝(답이 먼저 오고 그 뒤에 온다). `channel`이 없으면 메인 대화, 있으면 그 방(봇·팀·회의).
  - 앱은 그 방 대화 아래에 "생각하는 중…"(점 세 개 움직임)이나 `step…`을 보이고, `idle`이나 그 방의 비서 `message`가 오면 지운다.
  - 스트림에 새로 붙으면 지금 바쁜 방마다 한 번씩 온다. 3분 넘게 `idle`이 없으면 서버도 잊는다 — 앱도 3분 뒤엔 지운다.
- **모르는 `type`은 건너뛴다**(새 서버 + 옛 앱).
- 카드는 열린 동안 승인/거절/고치기를 보여 주고 `card_closed`가 오면 버튼을 없앤다. `closed` = 다른 채널(디스코드나 다른 앱)에서 먼저 처리됨.
  `edit` = 이번 행동은 거절, 비서가 "무엇을 고칠까요?"를 이어서 보냄. `send`·`pay`·`delete`는 이 카드의 `approve` 없이 실행되지 않는다.

## 5. views (읽기 전용 화면 데이터)

- 서버 플러그인이 능력 `app.views`로 등록한다(`{name, version, read(query), actions?}`). 이름은 `[A-Za-z0-9_-]`.
- `version`은 그 뷰의 응답 모양이 호환되지 않게 바뀔 때만 올린다. 필드 추가는 버전을 올리지 않는다(클라이언트는 모르는 필드 무시).
- 뷰가 없는 서버(그 기능이 꺼진 설치)는 `capabilities.views`에 없다 → 클라이언트는 그 탭·카드를 숨긴다.
- 쓰기가 필요한 것은 뷰의 `actions`(주인 자신의 수정, 되돌릴 수 있는 `write`)만. 보내기·결제·삭제는 뷰로 하지 않고 대화와 확인 카드를 거친다.

### 5.1 `today` v1 — 홈 요약
`GET views/today` → `{date:"YYYY-MM-DD", events:[{title,start,end?,allDay}]|null, todos:[{text,due?,source?}]|null, pendingCards:n,
replies?:[{from,text,source?,at?}]|null, spend?:{amount,count}}`
(`null` = 그 기능이 연결되지 않음. 일정은 지금 이후, 할 일은 오늘까지 마감 또는 마감 없음, 각 5개까지)

### 5.2 `usage` v1 — AI 사용량
`GET views/usage?period=day|week|month`(기본 `day`; day = 오늘 0시부터, week = 최근 7일, month = 이번 달 1일부터, 주인 시간대) →
```
{ period, since, until,
  totals: {calls, failures, failureRate, costUsd, inputTokens, outputTokens},
  byModel:   [{providerId, model, calls, failures, failureRate, costUsd, inputTokens, outputTokens}],
  byPurpose: [{purpose, calls, failures, failureRate, costUsd, inputTokens, outputTokens}],
  budget: {dailyUsd, monthlyUsd} | null }
```
`calls`는 성공 호출, `failures`는 실패 호출(시간 초과·한도·로그인 만료 등), `failureRate = failures / (calls + failures)`(0~1).
구독 CLI는 비용 0으로 집계된다.
ax-kit는 `daily:[{date, calls, failures, costUsd}]`도 보낸다(주인 시간대, `period=day`는 시간 단위 `"YYYY-MM-DDTHH:00"`, 빈 칸도 0으로 채움).

### 5.3 `knowledge` v1 — 지식 문서 (skill.knowledge가 등록)
- `GET views/knowledge` → `{documents:[{name, title, kind:"readme"|"profile"|"project"|"area"|"changelog", lines}]}`
- `GET views/knowledge?doc=<name>` → `{document:{name, title, kind, markdown, lines:[{id, topic, text, sources:[…], origin:"scan"|"memory"|"correction", at}]}}`
  (없는 문서는 `data.document: null`)
- `POST views/knowledge/correct` `{lineId, text}` → `{corrected:true}`. `text`가 빈 문자열 또는 `null`이면 "이 줄은 틀림(지움)".
  주인의 고침은 스캔·기억보다 우선하고 변경기록(`changelog`)에 남는다(기존 리뷰 답과 같은 흐름).

### 5.4 `approvals` v1 — 결재함
`GET views/approvals` → `{cards:[{cardId, summary, effects, effectLabels, note?, expiresAt}]}` (지금 열린 카드. 결정은 `POST cards/<id>`)

### 5.5 `improvements` v1 — 개선 기록
`GET views/improvements` → `{docs:[{id, title, body, updatedAt, needsReview, entries:[{at, text, author:{kind,id}}]}]}`
(구조화 문서 중 `kind = improvement | changelog`, 최근 갱신 순)

### 5.6 `health` v1 — 상태 점검
`GET views/health` → `{checkedAt, findings:[{id, area, ok, line, fix?}]}` (`doctor`·주간 보고와 같은 점검)

### 5.7 `spending` v1 — 지출(가계부)
`GET views/spending?month=YYYY-MM`(기본 이번 달) →
```
{ month, currency, total, count,
  byCategory: [{category, label, amount, count}],            // 금액 큰 순
  recent:     [{at, merchant, amount, category}],            // 최근 20건(옛 클라이언트 호환)
  previousMonth, previousTotal,                              // 지난달 합계
  budget: number | null,                                     // 월 예산(앱에서 정함)
  days:    [{date:"YYYY-MM-DD", total, count}],              // 달력용, 날짜 오름차순
  entries: [{id, at, date, merchant, amount, category, categoryLabel, categorySource:"rule"|"owner"|"model"|"none",
             source:"sms"|"app"|"chat"|"mail"|"manual", card?, original?:{amount,currency}, note?,
             claim?:"candidate"|"unsure", hasReceipt}],     // 그달 전부, 최신순. 제외한 내역은 없음
  categories: [{id, label}],                                 // 분류 고르기용(고정 id: food·cafe·groceries·transport·shopping·living·health·culture·travel·education·subscription·ai·infra·transfer·other)
  claims: {total, candidateCount, unsureCount} | null,       // 회사 청구(skill.expenses 꺼져 있으면 null)
  subscriptions: [{key, merchant, cadence:"monthly"|"yearly", amount, currency, nextDate, lapsed}] | null }
```
(지출 스킬이 꺼져 있으면 뷰가 없다. 카드번호는 처음부터 저장하지 않는다. 금액은 집 통화, 취소는 음수)

쓰기 — `POST views/spending/<action>`(주인 자신의 되돌릴 수 있는 수정, 효과 `write`. 기존 도구 `spending.*`·`expenses.mark`를 그대로 거쳐
감사 기록·확인 정책(`policy.confirmWrites`면 카드)·분류 학습이 채팅과 같다. 잘못된 입력·거절은 400 `shape`):

| action | 본문 | 응답 `data` |
|---|---|---|
| `categorize` | `{entryId, category, remember?=true}` — `remember`면 그 가맹점을 다음부터 이 분류로(학습) | `{entryId, category}` |
| `note` | `{entryId, note}`(200자, 빈 문자열이면 지움) | `{entryId, note}` |
| `claim` | `{entryId, claim:"claim"\|"personal", remember?=true}` — 회사 청구 여부(가맹점 기억) | `{entryId, claim}` |
| `exclude` | `{entryId, excluded}` — 합계에서 빼기/되돌리기(이체·테스트 결제). 삭제 아님 | `{entryId, excluded}` |
| `add` | `{merchant, amount(>0), date:"YYYY-MM-DD", time?:"HH:MM", category?, currency?, note?}` — 현금 등 수기 추가 | `{added:true, entryId?}` |
| `budget` | `{monthly: number \| null}` — 월 예산(null이면 없앰) | `{budget}` |

### 5.8 ax-kit의 `jobs`·`models`와 `today` 확장
- `today`: 일정에 `end`·`source:"calendar"`, 할 일에 `source:"todo"`. `replies`는 채팅 받은편지함(능력 `chat.awaiting`)과 답 기다리는 메일(`mail.awaiting`,
  1시간~7일, 5분 캐시)을 합쳐 최신순 5개(`source`: 카톡·디스코드·메일), 둘 다 없으면 `null`. `spend`는 지출 스킬(`spend.read`)이 있을 때만(오늘 합·건수, 집 통화).
- `jobs` v1: §7.8 형식. 묶음은 `ax`(코어 스케줄러의 모든 반복 작업)와 `off`(일시정지 스위치에 걸린 작업, 있을 때만). `schedule`은
  `{kind:"interval",everySec}` 또는 `{kind:"daily",at:"HH:MM",timezone}`, `source:"ax"`. 마지막 실행은 잡당 1건(코어 kv `core.jobs`), 오류는 가린 뒤 200자.
  `nextRunAt`은 스케줄러가 돌 때만, 멈춘 작업은 `null`. 스케줄러가 `list()`를 못 하면 뷰가 없다.
- `models` v1: §7.10 형식, ax-kit 정보만. `tiers`는 `deep`·`standard`·`fast`(강한 순), 후보는 설정 `llm.routes` 순서(`note` = 볼 수 있는 정보 수준 또는 '공급자 꺼짐').
  용도별 고정 표가 없어 `purposes`는 최근 7일 호출이 요청한 등급(호출마다 기록), `label` = 용도 id. `circuits`는 켜진 공급자 전부(`reason` = 연속 실패 수).
  `mismatch` = 그 용도에서 가장 많이 쓴 모델이 그 등급이나 더 강한 등급의 후보가 아님(뒤에 `-접미사`만 붙은 모델 id는 같은 모델). 등급 기록 전 호출은 `tier:""`.
- 공유 문구는 짝 맞춘 기기 종류로 "데스크톱에서/휴대폰에서"를 고른다. 기기 토큰이 틀리면 401 `{"ok":false}`(JSON).

## 7. ax-hq 어댑터 확장 (v1, 2026-11-18 확정)

ax-hq(오너 개인 설치)는 같은 v1을 `src/desktop-app/`에서 말한다. 디스코드에서 하던 일(비서 대화·결재/확인 카드·버튼/선택/입력 창·채널 글·팀 봇 글·
원격 화면 링크·첨부·반응)이 앱에서도 된다. 모두 **필드 추가**라 `protocol`은 1 그대로다.

### 7.1 `GET capabilities` (확정)
```
{ ok:true, protocol:1, server:"ax-hq", local:<로컬 토큰으로 왔으면 true>,
  features: ["chat","cards","notices","share","stream","events","views",
             "channels","card-options","card-select","card-form","card-reply","attachments","links","reactions"],
  views: [ {name:"today",version:1,actions:[]}, {name:"knowledge",version:1,actions:[]}, {name:"usage",version:1,actions:[]},
           {name:"spending",version:1,actions:["categorize","claim"]}, {name:"approvals",version:1,actions:[]},
           {name:"channels",version:1,actions:[]}, {name:"health",version:1,actions:[]} ],
  channels: [ {id, label, kind:"conversation"|"channel"|"team"} ] }      // §7.2 와 같은 목록
```
`GET status`에는 `local`과 `server:"ax-hq"`가 더 붙는다. 기능이 꺼진 설치는 그 뷰·기능을 빼고 보낸다.

### 7.2 채널(방)
- 이벤트의 `channel`은 디스코드 채널 이름 그대로인 방 id다: `결재`, `브리핑`, `장애`, `로그`, `팀장회의`, 팀 채널(`개발`, `qa`, `디자인`, `인프라`,
  `보안`, `법무`, `재무`, `cs`, `마케팅`, `영업`, `투자`, `크리에이터`, `신뢰안전`, `pm` …). **`channel`이 없으면 비서 대화**(디스코드 비서 채널과 같은 대화 기록).
- `GET views/channels` v1 → `{channels:[{id, label, kind, lastSeq, count}]}`(대화가 맨 앞, 그다음 임원 채널, 팀 채널 순).
- `GET events?channel=<id>`로 한 방만 받을 수 있다(`channel=` 빈 값 = 비서 대화). 스트림은 항상 전부.
- `POST messages`에 `channel`을 주면 그 방에서 쓴 것으로 처리한다: 생략/빈 값 = 비서, 팀 채널 = 그 팀장에게(디스코드 팀 채널과 같은 경로).
  `writable:true`인 방(아래 `dev-session`)도 그 방으로 받는다. 그 밖의 방은 `400 shape`.
- 채널 목록 항목의 `writable?: true` = 팀 방이 아니어도 오너가 쓸 수 있는 방(앱은 입력창을 보여 준다).
- ax-hq `dev-session`(표시 이름 '개발 세션'): 이 맥에서 도는 Claude Code 개발 세션과 이어진 방. 여기 쓴 글은 비서가 아니라
  세션으로 가고(세션이 꺼져 있으면 대기, 12시간 지나면 버림), 세션의 답은 `author:{id:"claude-code"}` 메시지로, 세션의 도구 실행
  허락 요청은 `options`가 `devperm:<요청 id>:allow|deny`인 카드로 온다(10분 만료). 방에 `yes <id>`/`no <id>`를 써도 같다.
  세션 쪽 `dev-session/*` 경로는 로컬 토큰 전용(폰 리스너는 404).
- 팀 봇 글은 `author: {id:"<팀 id>", name:"<팀장 이름>", avatar?}`.

### 7.3 카드 버튼·선택·입력 창
디스코드 카드의 컴포넌트가 그대로 온다. 각 `id`는 디스코드 `custom_id`와 같고, 서버는 디스코드 버튼과 **같은 처리기**에 넘긴다(결정은 오너 본인).
```
card.options?: [{id, label, tone?: "primary"|"danger"|"neutral"}]                  // 버튼. 있으면 승인/거절/고치기 대신 이것을 보여 준다
card.selects?: [{id, placeholder?, min?, max?, choices:[{id,label,description?}]}] // 선택 메뉴
card.form?:    {id, title, fields:[{id, label, value?, multiline?, required?}]}    // 입력 창(디스코드 모달)
```
`POST cards/<cardId>` 본문은 다음 중 하나:
`{decision:"approve"|"deny"|"edit"}`(옛 형식) · `{option:"<버튼 id>"}` · `{select:{id, values:[…]}}` · `{form:{id, fields:{<필드 id>: "<값>"}}}`
→ `{ok:true, state, reply?}`. `reply`는 처리 결과 한 줄(디스코드의 임시 답장). 버튼 결과로 입력 창이 열려야 하면 서버가 같은 카드에
`form`을 붙인 새 `card` 이벤트를 보낸다. 다른 곳(디스코드)에서 먼저 처리되면 `card_closed {state:"closed"}`. 이미 끝난 카드는 `410 gone`.
카드 id는 `[A-Za-z0-9_:.-]{1,200}`(경로에서는 URL 인코딩).

**직접 답하기**(feature `card-reply`, 2026-11-19): 선택지 밖의 답을 글로 보낸다.
```
card.freeText?: false          // 이 카드는 버튼만(도구 실행 허락 등). 없으면 글 답을 받는다
POST cards/<cardId>  {text:"<오너가 쓴 글, 1~4000자>"}  → {ok:true, state, reply?}
card_closed.answer?: "<그 글>"  // 모든 기기가 "답함: …"으로 닫는다
```
- 클라이언트: `card-reply`가 있고 `form`이 없고 `freeText !== false`인 열린 카드에 작은 글자 버튼 '직접 답하기' → 입력 칸/시트 → 보내기.
  `state`가 `open`이면 카드를 그대로 두고 `reply`(예: "이미 처리된 질문입니다")를 보여 준다. `form` 카드는 `400`이 아니라 `{state:"open"}`.
- ax-hq가 글을 넘기는 곳(결정은 오너 본인, 버튼과 같은 '한 번만'·만료 규칙):
  1. 결재 카드(`org:d:<id>:…`) → 디스코드 '✏️ 기타' 모달 제출과 같은 처리기(`org:dm:<id>`, 필드 `body`).
  2. 비서의 질문(`ch:<행>:<i>`) → 그 질문의 답(`ch:<행>:free`, 필드 `answer`; 버튼과 같은 행을 한 번만 차지).
  3. 그 밖(다음 행동 버튼, P0 결재, 알림 카드 …) → 카드를 닫고 그 글을 오너 말로 비서 대화에 보낸다. 카드 요약·선택지는
     디스코드 답글처럼 '참고 자료'(repliedTo)로만 붙는다(오너의 말로 취급하지 않음).
- 같은 카드에 동시에 두 번 보내면 하나만 처리되고 나머지는 `410 gone`.

### 7.4 반응
`POST messages/<seq>/react {emoji}` → `{ok:true}`. 👍/👎는 디스코드 반응과 같은 피드백(팀장 글 평가, 브리핑 뉴스 "이런 거 더/덜")으로 들어간다.

### 7.5 첨부
- 앱 → 서버: `POST share`(§3). 비서 대화로 들어가 디스코드 첨부와 같은 저장·읽기(사진 글자·사실 추출) 경로를 탄다. 12MB까지, 기기당 분당 10개.
- 서버 → 앱: 이벤트 `attachments[].url = "files/<id>"` → `GET files/<id>`(같은 인증) 원본 바이트. 30일 보관(폴더가 1GB를 넘으면 오래된 것부터 정리).
- 카드(`card`)도 같은 `attachments`를 싣는다(예: X 게시 확인 카드의 포스터). 앱은 카드 안에 썸네일로 보이고, 누르면 전체 화면.
  열린 카드의 첨부는 카드가 닫힐 때까지 보관(30일 정리에서 빠짐), 서버를 다시 켜도 같은 id로 받을 수 있다.
- 디스코드 embed 이미지(`image.url`·`thumbnail.url`): 로컬 파일이면 `attachments`로 바꿔 싣고, 외부 https면 `imageUrl`(문자열 하나, https만)로 싣는다.
  `imageUrl`은 토큰 없이 그 주소에서 직접 받는다.
- 데스크톱 앱은 웹뷰가 `files/<id>`를 직접 못 받으므로(토큰) Rust 명령 `get_file`로 바이트를 받아 blob URL로 그린다.

### 7.6 views 형식 차이
- `usage`: `currency:"KRW"`, 모든 행에 `costKrw`(원 단위 정수)와 `costUsd`, `byModel[].subscription`, `byErrorKind:[{errorKind,count}]`,
  `daily:[{date,calls,failures,costKrw,costUsd}]`(`period=day`는 시간 단위 `"YYYY-MM-DDTHH:00"`, KST). `budget:null`.
- `spending`: §5.7 그대로. 분류 id는 한국어 이름(`식비·카페`, `쇼핑`, `AI 서비스`, `인프라`, `구독·IT`, `교통`, `여행·숙박`, `의료`, `생활·공과금`, `기타`),
  `source`에 `kakao`(카드 알림톡)가 더 있다. 쓰기는 `categorize`·`claim`만.
- `knowledge`: 목록은 묶음 형식 `{updatedAt, areas:[{id,label,docs:[{id,title,lines,updatedAt}]}]}`(회사·회사 운영·운영·개인·개요),
  문서는 `?doc=<id>` → `{document:{name,title,kind:"area",markdown,lines:[]}}`(없으면 `null`). 읽기 전용.
- `health`: `{checkedAt, checks:[{id,group,label,status:"ok"|"warn"|"fail",detail}], summary:{ok,warn,fail}}`(`ax doctor` 요약, 5분 캐시).
- `today`(2026-11-18 채움): `{date, pendingCards, events:[{title,start,end,allDay}]|null, todos:[{text,due?,source:"todo"|"reminder"}],
  replies:[{from,text,source,at}]|null, spend?:{amount,count}}` — 일정은 오늘(KST) 남은 것과 종일 일정(취소·내가 거절한 것 제외, 12개),
  할 일은 마감 오늘·지남·중요(굵게) + 오늘 알림(12개, 같은 글 하나로), 답장은 답을 기다리는 메시지(카톡·메일·문자·슬랙·디스코드, 5개),
  `spend`는 오늘 지출 합(원). 캘린더가 한 번도 연결 안 됐으면 `events:null`. `approvals`: §5.4.
- `jobs` v1(읽기 전용): §7.8.

### 7.7 푸시(APNs)
- `capabilities.features`에 `"push"`(폰 리스너, 맥에 APNs 키가 있을 때). 앱: `POST push/register {token, environment:"development"|"production", topic}`
  → `{ok:true}`(기기당 하나, 같은 토큰은 새 기기로 옮김, `unpair` 때 지움). `POST push/test` → `{ok, status, reason?}`(그 폰에 시험 푸시 1건).
  맥에서는 `ax app push-test`.
- 보내는 것: 카드(항상, `interruption-level: time-sensitive`), 비서·팀장 `message`, `notice`(채널 `로그`·`팀장회의` 제외). 그 기기에 열린
  스트림이 있으면 보내지 않는다. 카드가 아닌 것은 기기당 시간 30건까지. 410·BadDeviceToken·DeviceTokenNotForTopic·Unregistered면 토큰 삭제.
- 본문: `{"aps":{"alert":{title,body},"sound":"default","badge":<열린 카드 수>,"thread-id":"<채널 또는 chat>","category"?},"seq","channel"}`.
  `body`는 마크다운을 뺀 첫 120자(`desktopApp.pushHideContent: true`면 "새 알림이 있어요").
- 카드: `cardId`, 그리고 `category`가
  - `"AX_CARD"`: 첫 primary(없으면 첫) 버튼 라벨이 승인 뜻(승인·확인·진행·허용·출시·보내기·실행…)이고 danger 버튼이 있을 때.
    `approve`/`deny`(버튼 id)·`approveLabel`/`denyLabel`이 붙는다. 앱은 알림의 승인/거절(기기 잠금 해제 필요)을 `POST cards/<id> {option}`으로 보낸다.
  - `"AX_OPEN"`: 그 밖(선택·입력 창, 승인 뜻이 아닌 버튼) — 누르면 결재 탭.
- **ax-kit 서버**도 같은 `push/register`·`push/test`를 쓴다. 키는 키체인 `app.apns.key`(.p8 내용), 키 id·팀 id는 설정
  `plugins["channel.app"].push.{keyId,teamId}` 또는 키체인 `app.apns.key-id`·`app.apns.team-id`. 셋 중 하나라도 없으면 `push`를 빼고
  `push/test`는 `503 push_off`(등록은 받아 둔다). 보내는 것: 카드·비서 `message`·`notice`, 그 기기에 열린 스트림이 없을 때만.
  `body`는 마크다운을 뺀 첫 80자(`push.hideContent: true`면 "새 알림이 있어요"). 카드는 항상 승인/거절이라 `category:"AX_CARD"`,
  `decision:true`(앱은 `{decision}`으로 답함), `channel:""`. 앱이 `unpair`하거나 CLI로 해제한 기기의 토큰은 지운다. 맥에서는 `ax-kit phone push-test [<기기 id>]`.
- **ax-kit 첨부**: 비서 답·알림(`OutgoingMessage.images`)과 확인 카드(도구의 `images(input)`)의 그림 — 로컬 파일은 내용이 실제 그림(png·jpg·gif·webp·heic,
  12MB까지)일 때만 `~/.ax-kit/files/app`에 복사해 `attachments`로, https 주소는 첫 하나만 `imageUrl`로. 30일 보관(열린 카드의 그림은 닫힐 때까지).

### 7.8 `jobs` v1 — 반복 작업
`GET views/jobs` → `{generatedAt, groups:[{id,label,jobs:[Job]}]}`. 묶음: `ax`(AX 스케줄러), `off`(코드에 있지만 지금 안 켜진 작업),
`other`(이 맥 launchd `com.axhq.*`, Claude Code 예약 작업, GitHub Actions `schedule` — 읽기만, 10분 캐시).
`Job = {id, name(한국어), detail?, schedule:{kind:"interval",everySec}|{kind:"daily",atKst}|{kind:"cron",expr}|{kind:"launchd",…}|null,
scheduleLabel("5분마다"·"매일 03:30"·"항상 켜짐"), enabled, running, lastRun:{startedAt,endedAt?,durationMs?,ok?,error?}|null, nextRunAt|null,
source:"ax"|"launchd"|"claude"|"github"}`. 마지막 실행은 잡마다 1건만 맥에 남는다(`~/.ax-hq/desktop-app/job-runs.json`, 오류는 가린 뒤 200자).

### 7.10 `models` v1 — AI 등급표(읽기 전용)
`GET views/models` → `{generatedAt, tiers:[{id:"S"|"A"|"B"|"C", label, candidates:[{vendor,model,effort?,note?}], fallback?}],
purposes:[{prefix, tier, label(한국어), pinned?:{vendor,model,effort?}, vendorOnly?}], activeProviders:[…],
circuits:[{vendor, state:"open"|"closed"|"half-open", until?, reason?}],
actual:{since, byTier:[{tier, models:[{vendor,model,calls,failures,costKrw}]}], byPurpose:[{prefix, tier, models:[…], mismatch}]}}`.
`actual`은 최근 7일 호출 기록, `mismatch`는 그 용도에서 가장 많이 쓴 모델이 등급 후보에 없을 때. `usage`에는 `tiersSummary:{tiers,purposes,mismatches}`가 붙는다.

### 7.9 디스코드와 같은 대화
- 앱 비서 대화와 `/`명령 답은 디스코드 비서 채널에도 `📱 앱에서: …` 한 줄 + 답으로 올라간다(`features.appRelayToDiscord`, 기본 켜짐).
- 앱 팀 방에 쓴 글과 팀장 답은 그 팀 디스코드 채널에도 올라간다. 반대로 디스코드 팀 채널·스레드·팀장회의 스레드에 쓴 대표 글과 팀장 답은
  앱 그 방에 `message`로 들어온다(같은 메시지 id·3분 안 같은 글은 한 번만).

## 6. 클라이언트가 지킬 것

- 토큰은 OS 보안 저장소에만, 로그·화면·크래시 보고에 쓰지 않는다.
- 받은 글(메시지·알림·문서)은 표시만 한다. 링크를 자동으로 열거나 글을 명령으로 실행하지 않는다.
- 오프라인이면 보낼 신호를 큐에 두되 인증번호처럼 보이는 문자·알림은 10분 뒤 버린다.

## 8. 2026-11-19 추가 (새 iOS 앱 요청 R1·R2·R3·R4·R5·R10·R11)

모두 v1에 더한 것이라 `protocol`은 1 그대로. `capabilities.features`에 `card-options`, `card-reply`, `remember`(규칙 저장소가 있을 때), `bots`, `delegation`(봇 목록이 있을 때)이 생긴다.

- **R1 봇과 방**: `GET views/bots` → `{ main: {name, subtitle}, groups: [{id, label, summary?, bots: [{id, name, role, channel, status, statusText?, isNew?}]}] }`. 묶음이 없는 봇은 `general`(기타). `POST messages {text, channel}` = 그 봇 방에 말하기(없는 방은 `400 shape`). 메시지 이벤트에 `channel?`(없으면 메인), 봇 글이면 `author {id, name}`. `GET events?channel=<id>` (빈 값 = 메인)은 그 방의 메시지만 남기고 카드·알림·위임 줄은 늘 포함.
- **R2 위임**: 이벤트 `{type:"delegation", bot, botChannel, task, state:"started"|"done"|"failed", summary?}`. 시작 한 번, 끝 한 번. 봇의 답은 봇 방에 메시지로. 위임 줄은 푸시하지 않음.
- **R3 결재 카드**: 카드에 `options: [{id:"approve", tone:"primary"}, {id:"deny", tone:"danger"}]`, `freeText: true`. `POST cards/<id>`는 `{option, remember?}` | `{text}` | (옛) `{decision}`. `{text}`는 이 행동에 대한 '아니요'이고, 그 글이 오너의 다음 지시가 됨(채팅에 오너 글로 보이고 비서가 이어서 처리). 응답 `{state, answer?}` 또는 `{state:"edit", reply}`. `card_closed.answer` = 고른 선택지 이름 또는 쓴 글. 모르는 `option`은 `400 option`.
- **R11 앞으로는 알아서**: 카드에 `remember?: {label, detail?}`(문구·범위는 서버). `{option:"approve", remember:true}`이면 규칙이 생기고, 같은 범위의 다음 일은 카드 없이 실행 + "알아서 했어요" 알림 + 캘린더 '한 일'. 기본 범위는 '완전히 같은 행동'이며 결제·삭제는 도구가 범위(금액 상한 등)를 줄 때만 제안. 전체 정지가 규칙보다 우선. `GET views/autonomy` → `{rules: [{id, label, detail?, since, uses, origin, paused?, approvals?, denials?, corrections?}], alwaysAsk}`, `POST views/autonomy/revoke {id}`, `POST views/autonomy/resume {id}` → `{id, resumed}`.
  - **자동 실행 승격**: 같은 범위(도구 + 범위 키)의 카드를 서버가 셈(승인·거절·글로 고침·실패·나중에 바로잡음). 깨끗한 승인(실행됐고 바로잡지 않은 승인) **20번 이상**, 그 범위 결정의 **95% 이상**, **최근 10번에 거절·고침 없음**이면 한 번 물음: 카드 topic `autonomy:promote:<도구>:<범위 해시>`, 문구 "이 일은 지난 N번 모두 승인하셨어요. 앞으로는 알아서 하고 결과만 알려 드릴까요?", 선택지 `yes`(규칙 생김) · `later`(깨끗한 승인 30번 더 뒤 다시) · `never`(다시 안 물음). 결제·삭제, 확실하지 않은 입력(카드 `note`가 붙는 일), 받는 사람이 정해지지 않았거나 3번 미만 보낸 사람에게 보내는 일은 묻지 않음(기본 범위 '완전히 같은 행동'은 받는 사람이 행동에 고정돼 있어 허용). `yes`로 생긴 규칙은 `origin:"promoted"`(카드 체크로 생긴 것은 `"card"`)이고 다른 규칙과 똑같이 보이고 취소됨. `approvals`/`denials`(거절+고침)/`corrections` = 그 범위의 셈.
  - **멈춤**: 승격된 규칙으로 한 일이 **연달아 두 번 실패**하거나 오너가 되돌림·불만을 말하면(비서가 도구 `autonomy.correct`를 부름) 규칙이 `paused`(ISO 시각)가 되고 알림 한 번("알아서 하던 일을 멈췄어요: …"). 멈춘 동안은 다시 카드로 묻고, 다시 승격을 제안하지 않음. `resume`으로 다시 켬, 카드에서 '앞으로는 알아서'를 체크해도 다시 켜짐(`origin:"card"`). 규칙으로 한 일의 "알아서 했어요" 알림은 **실행이 끝난 뒤** 성공했을 때 보냄.
- **R4 문서 지도**: `GET views/docgraph` → `{layers: [{id, label}], nodes: [{id, title, layer, group?, summary?, updatedAt?, weight 1..4}], links: [{from, to, label}]}`. 연결은 코드가 찾음(나↔영역·프로젝트, 같은 자료 인용, 제목 언급, 팀↔회사). `?doc=<id>` → `{document: {id, title, layer, markdown, updatedAt?, related: [{id, title}]} | null}`.
- **R5 캘린더**: 캘린더가 쓰기 가능하면 액션 `add`: `POST views/calendar/add {title, allDay, start (allDay면 YYYY-MM-DD), end?, place?}` → `{id}` (초대 없는 오너 일정, 끝 기본값 = 1시간 뒤/다음 날). `GET views/calendar?month=YYYY-MM` → `{month, timezone, days: [{date, events: [{id, title, start, end?, allDay?, place?}], done: [{id, title, at, bot?, detail?}]}]}` — 그달 모든 날. `done`은 작업 기록(끝난 변경 행동, 규칙으로 한 일, 위임).
- **R10 정지**: `GET status`에 `stopped: bool`.

## 9. 2026-11-19 추가 2 (R14 녹음 → 회의록, R15 같은 질문 두 번 묻지 않기)

- **R15**: 카드에 `topic?`. 서버가 topic마다 오너의 마지막 답을 기억함(승인 → 다시 묻지 않고 그대로 + 알림, 거절·직접 입력 → 근거가 바뀌기 전엔 안 물음, `나중에` → 때가 되면(기본 약 20시간 뒤) 한 번만 다시). 열린 카드가 있는 topic으로 다시 물으면 **같은 `cardId`로 새 `card` 이벤트**(내용 갱신, 클라이언트는 교체). 이런 카드는 선택지가 여러 개일 수 있음(예: 개발 봇에게 맡기기·설계만 먼저·나중에·안 함).
- **R14**: 기능 `recordings`, 뷰 `recordings` → `{recordings: [{id, title?, startedAt, durationSec, status: receiving|transcribing|summarizing|done|failed, statusText?, documentId?, driveUrl?}]}` (최신순).
  - `POST recordings/<id>/chunks/<index>`: 본문 = 오디오 바이트(조각 하나 ≤12MB), 헤더 `X-Chunk-Total`(1..64), `X-Started-At`, `X-Duration-Sec`. `<id>` = `r_[a-z0-9-]{1,40}`. 응답 `{received, complete}`(`received` = 0번부터 빈틈없이 받은 조각 수). 다 받은 뒤 다시 보내면 `{received: total, complete: true}`.
  - 처리: 받아쓰기(설정 `plugins["skill.recordings"].transcribe` — 기본은 맥 안의 whisper.cpp `{kind:"whisper", model?, language?}`(ffmpeg로 16kHz wav 변환 후 `whisper-cli`, 모델 기본 `~/.ax-kit/models/ggml-large-v3-turbo.bin`), 또는 `{kind:"api", baseUrl, model, keySecret}` / `{kind:"command", command, args}`; 도구나 모델이 없으면 `failed` + 설치 방법) → 회의록(누가·언제·요약·정한 것·할 일·해 볼 만한 것) → 문서 `meeting:<id>`(문서 지도 `d:meeting:<id>`, 층 `meeting`) → 알림 "회의록을 정리했어요: <제목>" → Drive 저장(topic `drive:save:meeting-notes`, 처음 한 번만 묻고 이후 자동, Google 연결에 `drive.file` 권한 필요) → 개발할 만한 아이디어마다 제안 카드(topic `dev:suggest:<아이디어 키>`), 맡기면 개발 봇에게 `delegation`.
  - 오디오·받아쓴 글은 맥에만(`~/.ax-kit/files/recordings/<id>/`), 받아쓰기 도구로만 나감.

## 10. 2026-11-19 추가 3 (R3 선택지 설명·육하원칙, R6, R7, R12, R13)

- **R3 선택지 설명·맥락**: 카드 `options[].detail`(그 선택이 하는 일 한 줄). 기본 선택지도 채움(`approve` "적힌 그대로 지금 해요", `deny` "아무것도 하지 않고 끝내요"). 카드 `note` = **육하원칙 맥락**(누가·언제·무엇을·왜) 1~2문장 + (있으면) 묻는 이유(추측한 날짜 등). 맥락은 모델이 도구 호출마다 쓰는 `why`(표시만, 정책에는 안 씀). 300자로 자르고, AI를 향한 지시가 섞이면 통째로 뺌. `summary`는 그대로 코드가 만든 정확한 행동.
- **R6 반복 작업 켜고 끄기**: `POST views/jobs/toggle {id, enabled}` → `{id, enabled}`. 끄면 일시정지 스위치(30일, 화면 `detail`에 언제까지인지)이고 **스케줄러가 실제로 건너뜀**. 회사·플러그인 단위로 꺼진 작업은 `toggleable:false`(대화로 켬). 없는 id는 `400`.
- **R7 AI 연결**(기능 `ai-connect`): `GET views/providers` → `{providers: [{id, label, kind: api_key|subscription|local, connected, status: ok|error|off, detail, keyHint?, help?, models, editable}]}`. 키로 연결할 수 있는 AI: Claude(`anthropic`), ChatGPT(`openai`), DeepSeek(`deepseek`, 민감 정보는 맡기지 않음) + config.json의 공급자. `POST providers/<id>/key {apiKey}` → 작은 확인 호출 후 Keychain에만 저장, 재시작 없이 바로 씀 → `{ok:true, status, detail}`. 거절된 키는 저장하지 않고 `400 {ok:false, error:"key", message}`. `POST providers/<id>/disconnect {}` → 키 지움. 키는 응답·로그·감사 기록에 남지 않음(`keyHint` = 끝 3자).
- **R12 AI 등급과 용도**(기능 `model-tiers`): `GET views/modeltiers` → `{tiers: [{id:"S"|"A"|"B", label, summary, models: [{id:"<공급자>/<모델>", label, provider, available, note?}]}], purposes: [{id, label, detail?, tier, chosen, calls7d}]}`. S=깊게, A=보통, B=빠르게(위에서부터 먼저 씀). 용도 id = 기능 이름 첫 단어(`assistant`, `recordings`, `company`…) 또는 봇 `bot.<id>`(봇 방 대화). `POST views/modeltiers/rank {tier, order}`(같은 모델 집합, 순서만), `POST views/modeltiers/purpose {id, tier|null}`(null = 원래대로). 맥의 로컬 저장소에 저장, 바로 적용.
- **R13 봇 캐릭터**: `bots[].avatar = "files/avatar-<봇>.png"`(기기 토큰으로 받기). ChatGPT(OpenAI) 키가 연결돼 있으면 맥이 봇마다 한 번 3D 점토 캐릭터를 그림(봇 이름과 한 줄 역할만 보냄, 장당 약 0.01달러, 실패 시 최대 3번). 키가 없으면 `avatar` 없음 → 앱이 그림. `status: working`은 위임 중.

## 11. 2026-11-19 추가 4 (R16 봇 팀, R17 팀장회의·봇끼리 대화)

- **R16 봇 팀**(기능 `bot-teams`): 봇은 늘 팀으로 만들어짐 = 팀장 1 + 직원 3(1~5) + 개발 팀이면 검수 1. 대화로 만든 봇(`bots.create`), 회사 모드 팀, 첫 문서 스캔(회사마다 묶음 + "<회사> 업무" 팀, 개발 프로젝트마다 개발 팀)이 모두 같은 구조. 기본 등급 팀장 A · 직원 B · 검수 S.
  - `views/bots`: `groups[].meetingChannel`, `groups[].teams: [{id:"team-<이름>", name, purpose?, channel(=id), kind, tiers:{lead, staff, reviewer?}, members:[봇 id, 팀장→직원→검수 순]}]`, `bots[].rank: lead|staff|reviewer`, `bots[].team`, `bots[].tier: S|A|B|C`.
  - `POST views/bots/createTeam {group? | newGroupLabel, name, purpose?, kind:"dev"|"general", tiers?:{lead?, staff?, reviewer?}, staffCount?}` → `{teamId, channel, group}`. 이름·역할 문구는 서버("App 팀장", "App 직원 1", "App 검수").
  - `POST views/bots/setTiers {teamId, tiers:{lead?, staff?, reviewer?}}` → `{teamId, tiers}`. 역할마다 `bot.<봇 id>` 용도의 등급으로 바로 적용(R12에서도 보임). C는 B와 같은 '빠르게' 등급에서 돌지만 C로 표시.
- **R17 팀 방·회의 방**: 팀 방 `channel = team-<…>`에 말하면 팀장이 받아 직원에게 나눠 맡기고(검수 봇이 확인), 팀장이 결과를 답함. 팀장에게 위임해도 같은 흐름. 봇끼리의 말은 `message` 이벤트로 `author {id, name}` + 새 필드 `to {id, name}`, 글은 한두 문장의 쉬운 말(JSON·도구 호출은 보내지 않음).
  - 회사(묶음)마다 `meetingChannel = meet-<묶음 id>`. `POST views/bots/meeting {group, topic}` → `{channel, started:true}`(백그라운드). 팀장마다 두 번 말하고 첫 팀장이 "결론: …"으로 마침. 메인 대화에 알림 "<회사> 팀장회의 결론: …". 회의 중 오너가 회의 방에 쓰면 다음 발언자가 읽음, 회의가 없을 때 쓰면 그 글을 주제로 회의를 엶.

## 12. 2026-11-19 추가 5 (R18 초기 세팅 CLI)

- `bash install.sh`(멱등): Homebrew 확인 → Node 22.13+·pnpm → 코드(이 체크아웃, `$AX_KIT_DIR`, 없으면 `gh repo clone`) → `pnpm install` → `ax-kit`을 Homebrew bin(또는 `~/.local/bin`)에 연결 → `ax-kit setup`.
- `ax-kit setup`: 설정이 있으면 기능 표를 먼저 보이고 "꺼진 것만 이어서 / 처음부터 / 그대로" 중 고름. 꺼진 것만: AI 연결, Google(캘린더·Gmail·Drive), 받아쓰기(whisper.cpp + ffmpeg + 모델, 이어받기), 첫 문서 살펴보기(끝나면 회사별 묶음·팀 자동 생성, R16), launchd, 앱 짝 맞추기 QR. 푸시 키·Tailscale은 다른 기기가 필요해 명령만 안내.
- `ax-kit features`: 기본·앱·AI·Google·기능 묶음별 ✓/✗ 표와 꺼진 것의 켜는 법. `ax-kit update`: `git pull --ff-only` → `pnpm install --frozen-lockfile` → 서비스가 있으면 재시작.

## 13. 2026-11-19 추가 6 (C 등급, 팀 구성 하네스, 등급표 하네스)

- **C 등급**: 등급표가 S(깊게)·A(보통)·B(빠르게)·C(가장 싸게: 작은 모델·맥 안 모델). `views/modeltiers`의 `tiers`가 4개, `rank`·`purpose`·`setTiers`·`createTeam`이 C를 받음. C에 모델이 아직 없으면 B 모델로 돌아감.
- **팀 구성**: `createTeam {group | newGroupLabel, name, purpose?, kind, staffCount 1..6, reviewerCount 0..3, tiers}` = 오너가 정한 그대로(`decidedBy:"owner"`), `{…, auto:true}` = 팀 구성 하네스. 문서 스캔·대화로 생기는 팀도 하네스.
  - 하네스: 모델이 `{staffCount, reviewerCount, tiers, reason}`을 제안하고 코드가 검증(범위 고침 · 코드·돈·대외 발송이면 검수 ≥1, 검수 등급 ≥ 팀장 등급 · 예산이 빠듯하면 한 등급씩 낮춤). 답이 이상하면 규칙 기본값.
  - 팀 항목에 `staffCount`, `reviewerCount`, `decidedBy:"owner"|"ai"`, `reason?`. `setTiers`를 하면 `decidedBy:"owner"`가 되고 그 뒤로 AI가 바꾸지 않음. 운영 중 인원 조정은 §15.
- **등급표 하네스**:
  - 연결된 AI의 모델 목록을 매일(04:40)과 키를 연결한 직후에 읽음. 대화용 모델만, 계열마다 최신 하나. 규칙(계열·크기)으로 S/A/B/C에 놓고 `tiers[].models[].note`에 쉬운 이유. 같은 계열이면 새 버전이 앞.
  - 연결 직후에는 모든 모델이 바로 들어감. 나중에 새로 나온 S 모델은 결재로 한 번 물어봄.
  - 주 1회 지난 30일 사용량·실패·비용을 봄. 예산이 빠듯하면 위험이 낮은 용도(문서·지출·기억 정리 등)를 한 등급 내림(바로 적용 + 기록). 자주 실패하는 용도를 올리는 건 결재 카드로 물어봄(topic `tiers:review:<YYYY-Www>`, 선택지 그렇게 바꾸기 / 지금 그대로 / 나중에).
  - 오너가 순서를 정한 등급(`models[].chosen:true`)과 오너가 정한 용도 등급(`purposes[].chosen:true`)은 건드리지 않음. `views/modeltiers`에 `changedAt`, `changes:[{at, text}]`(최근 10개).
  - 시험 세트와 부하 나누기는 §15.

## 14. 2026-11-19 추가 7 (R8 봇별 사용량·맥 상태, R9 서버가 그리는 화면)

- **R8 사용량**: `views/usage`에 `byBot: [{botId, name, calls, failures, costUsd}]`(비용 많은 순). 봇 방·팀 일은 용도 `bot.<id>…`로 기록되므로 그 합.
- **R8 맥 상태**: `GET views/hardware` → `{checkedAt, machine:{name, model?, os?, uptimeSec}, cpuPercent, memory:{used,total,unit:"GB"}, disk?, thermal?: nominal|fair|serious|critical, power?, network?:{tailscale}, server:{version, uptime, stop}, summary}`. 10초 캐시(앱은 15초마다 읽음). 저장 공간 20GB 미만·발열·CPU 90% 이상이면 `summary`에 쉬운 경고.
- **R9 서버가 그리는 화면**(기능 `blocks`): `capabilities.views[]`에 `ui:"blocks"`, `title`, `icon`(SF Symbol). `GET views/<name>` → `{title, blocks}`. 블록 `text`·`stat`·`list{title?, rows[{title, detail?, trailing?}]}`·`note`·`ask{title, message}`(대화에 message만 보냄). 지금 있는 화면:
  - `abilities` "할 수 있는 일"(sparkles): 켜진 기능, 꺼진 기능과 켜는 법.
  - `work-week` "이번 주 한 일"(checklist): 지난 7일 건수, 누가 했는지, 최근 15건.
  - 플러그인은 `AppView`에 `ui:"blocks"`를 붙여 새 화면을 더할 수 있음.

## 15. 2026-11-19 추가 8 (팀 인원 조정 제안, 모델 시험 세트, 공급자 사이 부하 나누기)

- **팀 인원 조정**: 팀 일마다 기록(맡긴 일 수, 못 끝낸 일, 팀장이 더 많은 인원을 원했는지, 바쁠 때 새 일이 왔는지). 지난 7일 5번 이상 돌았고
  - 절반 이상 일이 밀렸으면 → 직원 +1(최대 6)
  - 맡긴 일의 30% 이상을 못 끝냈으면 → 검수 +1(최대 3)
  - 결재 카드로 한 번 물어봄(topic `team:resize:<팀 id>`, 선택지 `resize` / `keep` / `later`). 승인하면 바꾸고 `decidedBy:"owner"`(더 제안 안 함). `decidedBy:"owner"` 팀은 제안하지 않음. 줄일 때 봇은 지우지 않고 `status:"off"`(방 기록 유지), `members`에서 빠짐.
- **모델 시험 세트**: 새로 찾은 모델마다(한 번에 최대 6개) 짧은 시험 3개(JSON 형식, 한국어 한 문장 요약, 정확히 한 단어로 답하기)를 한 번 돌림. 3개 중 2개 이상 통과하면 규칙대로, 아니면 한 등급 낮춤. `note`에 "시험 3개 중 3개 통과 · 평균 1.2초"처럼. 같은 공급자의 같은 등급 안에서는 점수 높은 모델이 앞. 시험 비용은 예산에 `llm.eval`로 들어감.
- **부하 나누기**: 주간 점검에서 한 등급의 일이 한 AI에 80% 넘게 몰리고 그 등급에 쓸 수 있는 AI가 둘 이상이면, 그 등급은 AI마다 첫 모델이 번갈아 먼저 받음(실패하면 기존처럼 다음으로). 오너가 순서를 정한 등급은 번갈아 맡기지 않음. 바뀌면 `changes`에 쉬운 말로.

## 16. 2026-11-19 추가 9 (데스크톱 앱 요청 D2·D3·D5·D7·D8·D9, 봇 역할 프롬프트)

- **D2**: §1 참고. 앱마다 자기 토큰 파일만 읽음.
- **D3**: 로컬 토큰(127.0.0.1 전용)의 상한은 분당 240. 폰 토큰은 그대로 60.
- **D5**: 녹음 조각의 `Content-Type`이 `audio/webm`(또는 opus·ogg)이면 `audio.webm`으로 모아 받아쓰기에 넘김. 로컬 Whisper는 ffmpeg로 바꾸고, API 받아쓰기는 webm 그대로 보냄.
- **D9**: `Last-Event-ID`가 서버의 마지막 seq보다 크면 0으로 보고 처음부터 다시 보냄.
- **D8**:
  - `views/usage`의 `daily[]` 줄마다 `byModel {모델: {calls, costUsd}}`와 `byBot {봇 id | "main": {calls, costUsd}}`. 성공한 호출만 세므로 합이 그 줄의 `calls`·`costUsd`와 같음.
  - `views/calendar`의 `done[].team?`.
  - `views/approvals`의 `history.weeks[8]` = `{week(월요일), asked, approved, denied, written, auto}`. `auto` = 작업 기록의 '알아서 한 일'.
- **D7 길찾기**(기능 `routes`, 한국 생활 묶음 + 키 `ko.kakao.rest-key`, `ko.odsay.key`):
  - 일정의 `place`를 카카오 장소 검색으로 찾아 `views/calendar`·`views/today` 일정에 `geo {lat, lng, address?}`. 결과는 계속 캐시(못 찾은 것도). 온라인·화상·링크는 건너뜀. 한 번 읽을 때 새로 찾는 건 5개까지.
  - `GET views/routes?date=` → 요청 모양 그대로. 구간은 집 → 시간 있는 일정 차례로. 대중교통(ODsay)과 자동차(카카오 모빌리티)를 함께 보여 주고, `recommended`는 더 빠른 쪽인데 차이가 5분 안이면 대중교통. `leaveAt` = 도착 − 걸리는 시간 − 5분. 앞 일정이 끝나기 전에 나가야 하면 `note`. 날짜별 캐시(일정·집이 바뀌면 다시 계산).
  - `POST views/routes/setHome {query}` 또는 `{lat, lng, name?}` → `{home}`. 집이 없으면 `{origin:null, legs:[], note}`.
- **봇 역할 프롬프트**:
  - 봇마다 `instructions`(일하는 방식, 최대 1500자)와 `instructionsBy: "default"|"ai"|"owner"`가 `views/bots`의 `bots[]`에 있음.
  - 만들자마자 직급(팀장·직원·검수)과 팀 목적에 맞는 기본 글이 들어가고, 뒤에서 AI가 팀 목적에 맞게 다시 씀(`ai`). 매 대화의 봇 설명에 들어감.
  - `POST views/bots/setInstructions {botId, text}` → 오너 글(`owner`). 그 뒤로 AI가 바꾸지 않음. `text:null`이면 기본 글로 되돌림.
  - 결재를 건너뛰라는 글이나 AI를 향한 숨은 지시는 받지 않음(`400`과 쉬운 이유). 확인 규칙은 코드가 지키므로 프롬프트로 풀 수 없음.

- **뷰 액션의 400**: 오너에게 보일 이유가 있으면 `{ok:false, error:"shape", message:"<쉬운 한 문장>"}`(예: "그런 봇이 없어요", "결재 없이 하라는 내용은 넣을 수 없어요…", "그 주소를 찾지 못했어요."). 요청 모양이 틀린 개발용 오류에는 `message`가 없음. 앱은 `message`가 있으면 그대로 보여 줌.

## 17. 루틴

오너가 "매일 아침 9시에 X 해줘"처럼 반복할 일을 말하면 비서가 `routines.add`로 루틴을 만듦. 루틴은 정해진 때에 오너가 방금 말한 것처럼 비서(또는 봇, 팀장이면 그 팀) 한 턴으로 돌고, 결재 카드와 비상 정지는 그대로 적용됨. 기능 이름 `routines`(`capabilities.features`).

- **결과**: 비서 루틴은 알림(`kind:"routines.result"`, 첫 줄 `[루틴] <제목>`), 봇 루틴은 그 봇 방의 메시지. 한 일 기록(`kind:"routine"`)에도 남음.
- **멈춤**: 세 번 연속 실패하면 `enabled:false`로 멈추고 알림 한 번(`kind:"routines.paused"`). 다시 켜면 실패 횟수는 0부터.
- `GET views/routines` →
  `{routines:[{id, title, instruction, schedule, scheduleLabel, bot?:{id,name}, enabled, createdAt, lastRun?, lastResult?, lastOk?}], followUps:[{bot:{id,name}, what, dueAt}], limit:30}`
  - `schedule`: `{kind:"daily", at:"09:00"}` · `{kind:"weekly", day:"mon".."sun", at}` · `{kind:"every", hours:1..24}`(오너 시간대).
  - `scheduleLabel`: "매일 오전 9시", "매주 월요일 오후 2시 30분", "3시간마다". 화면에는 이것을 보여 줌.
  - `followUps`: 봇이 `bots.follow_up`으로 남긴 나중 확인(봇마다 최대 1개). 때가 되면 봇이 다시 확인하고 그 방에 알림.
- `POST views/routines/toggle {id, enabled}` → `{id, enabled}`. 켜고 끄기.
- `POST views/routines/remove {id}` → `{id, removed:true}`. 목록에서 빠지고 다시 돌지 않음(서버에는 흔적만 남김).
- 없는 `id`나 잘못된 본문은 400. 루틴은 최대 30개.

## 18. 메일 도착 처리

Gmail이 연결돼 있으면 기본으로 켜짐. 2분마다 받은편지함의 새 메일을 봄(첫 실행은 지금 있는 메일을 기억만 하고 아무것도 안 함, 한 번에 최대 20통). 프로모션·소셜·포럼 분류, 내가 보낸 메일, 뉴스레터 발신자, 조용히 할 발신자는 건너뜀. 메일마다 싼 모델 한 번(용도 `mail.triage`, 등급 fast, 민감)으로 중요도·한 문장 요약·제안을 받음. 메일 본문은 지시문 줄을 지운 뒤 data 블록으로만 들어감.

- **오너가 보는 것**
  - 중요(`high`): 바로 알림(종류 `mail.important`) "중요 메일 · 보낸 사람: 제목 / 한 문장 요약 / 제안: …".
  - 보통(`normal`): 모아서 몇 시간마다 한 번 알림(종류 `mail.digest`) "새 메일 N통 정리".
  - 낮음(`low`): 알리지 않음.
  - 제안은 결재 카드로 한 번만 물어봄(topic `mail:reply:<메일 id>`, `mail:event:<메일 id>`, `mail:todo:<메일 id>`, 선택지 `yes` / `later` / `no`). 승인하면 실제 도구 호출로 실행되고 정책이 그대로 적용됨.
    - 답장: `mail.draft_reply`로 초안(쓰기) → `mail.send_draft` 보내기 카드(보내기는 항상 확인). 거절하면 초안은 임시보관함에 남음.
    - 일정: `calendar.add_event`. 메일에 그 날짜가 적혀 있어야 하고(인용 근거 확인) 아니면 제안 자체를 버림. 연도 없는 날짜·오전/오후 모름 같은 추측이면 카드로 한 번 더 물어봄.
    - 할 일: `todo.add`. 마감이 메일에 없으면 마감 없이 할 일만.
- **새 도구**: `mail.compose {to[], cc?, subject, body}`(새 메일 초안, 쓰기 — 보내기는 `mail.send_draft`), `mail.mute_sender {email}`(쓰기, 그 발신자 메일은 더 정리하지 않음).
- **설정** `plugins["skill.mail"].triage`: `enabled`(기본 true), `everyMinutes`(기본 10), `digestHours`(기본 3), `quietSenders`(주소 또는 `@도메인` 목록).
- **Gmail 정리(선택)**: `ax-kit connect google`에서 "Gmail 정리"를 고르면 `gmail.modify` 권한을 더 받고 `plugins["connector.gmail"].organize = true`가 저장됨(기능 표 `gmail-organize`). 그때만 능력 `mail.organize`가 생김. 메일을 지우거나 휴지통·스팸으로 옮기지 않음 — 받은편지함에서 빼기(보관)와 라벨만.
  - **새 도구**: `mail.labels {}`(읽기), `mail.archive {mails[]}`, `mail.label {mails[], add?[], remove?[]}`(쓰기, 한 번에 최대 50통, 없는 라벨은 새로 만듦). `mails[]`는 `mail.search` 결과 그대로 `{id, from, subject, category?}` — 실행 직전 메일함과 다시 맞춰 보고 다르면 아무것도 안 바꿈. 카드에는 보낸 사람·제목 5통까지, 나머지는 "외 N통". "앞으로는 알아서" 범위는 Gmail 분류(예: 광고) → 회사 도메인 → 한 발신자 순으로 좁게.
  - 권한이 없으면 세 도구 모두 "ax-kit connect google 을 다시 실행해 Gmail 정리를 고르세요" 안내로 거절(카드 없음).
  - `mail.search` 결과에 Gmail 분류 `category?`(`promotions`·`social`·`updates`·`forums`)가 붙음.
  - 정리 알림(`mail.digest`)을 보낼 때 그사이 모인 광고성 메일(뉴스레터·마케팅 발신자, 모델이 "낮음·할 일 없음"이라 한 프로모션·업데이트 탭 메일; 중요·별표·조용히 할 발신자는 제외, 최대 50통)이 있으면 결재 카드 하나로 "광고·알림 메일 N통을 보관할까요?"를 물음(topic `mail:archive:<정리 id>`, 선택지 `yes` / `no`). 승인하면 `mail.archive`로 실행.

### 18.1 2026-11-23: 답장 초안은 알아서, 보내기만 확인
- 메일마다 종류(`kind`)를 정함: `question`·`document_request`·`scheduling`·`introduction`·`notice`·`other`, 그리고 켜진 팩이 더한 종류(인재 소개 팩: `hiring_request`·`application`).
- 답장 제안이 있으면 **묻지 않고 바로 초안을 씀**(`plugins["skill.mail"].triage.autoDraft`, 기본 true; 끄면 예전처럼 "초안을 만들어 둘까요?" 카드가 먼저 옴).
  초안은 더 좋은 모델(용도 `mail.draft`, 등급 standard)이 오너 프로필·아래 정보를 보고 씀. 그다음 `notice` "OO님 메일에 답장 초안을 써 뒀어요(임시보관함). 보낼지만 골라 주세요."(+ 첨부·확인할 점 한 줄)가 오고, 이어서 늘 그렇듯 `mail.send_draft` 보내기 카드가 옴.
  - `document_request`: 요청한 자료를 이 맥에서 찾아(`files.find`, 이름→내용) 맞는 파일을 초안에 첨부(최대 3개, 합쳐 7MB). 못 찾으면 첨부 없이 "확인 후 보내드리겠다"는 초안과 "찾지 못했어요" 줄.
  - `scheduling`: 앞으로 7일 평일 10~18시 중 캘린더 빈 시간을 초안에 제안.
  - 팩 종류: 팩이 준 정보로 초안을 씀(채용 요청이면 명부에 맞는 사람 수와 경력 요약, 이름은 넣지 않음). 지원 메일의 첨부 이력서는 후보자 명부에 넣고 `notice` "메일에 온 이력서 N개를 후보자 명부에 넣었어요."
- 보내기 카드(`mail.send_draft`)에 첨부 파일 이름이 함께 보임. 일정·할 일 제안은 예전처럼 먼저 물어봄.
- `mail.draft_reply`에 `attachments?: ["~/…"]`(집 폴더 안, 숨김·키 파일 제외, 최대 5개·7MB).

### 18.1a 메일 안전장치 (2026-11-23)
- **위조 의심**: 받는 서버의 인증 결과(DMARC 실패, 또는 SPF 실패에 DKIM도 통과 못 함)나 보낸 사람 이름 칸에 다른 주소가 들어 있으면 `notice`(종류 `mail.important`)
  "⚠️ 위조 의심 메일 · OO: 제목 / … 링크·첨부를 열지 말고, 아는 연락처로 따로 확인해 주세요. 이 메일에는 초안을 쓰지 않았어요."만 보낸다. 초안·첨부·팩 처리·제안 카드는 없다.
- **답장이 필요 없는 메일**: no-reply·알림 주소, 메일링 리스트(수신 거부 머리말), 알림(`notice`) 메일에는 답장 초안을 쓰지 않는다(일정·할 일 제안은 그대로).
- **근거 없는 숫자**: 초안에 메일·빈 시간·찾은 파일·팩 정보·프로필에 없는 날짜·시간·금액·개수가 있으면 초안 알림에 "확인 필요: 초안의 "12월 3일"은(는) 메일이나 찾은 정보에 없어요." 줄이 붙는다(초안은 그대로, 보내기 전에 오너가 확인).

## 18.3 놓친 메시지 (2026-11-23)
- 답하는 중에 서버가 꺼지거나 멈추면, 다시 켜질 때 그 오너 메시지를 **한 번** 다시 처리한다(12시간 안의 것만, 두 번 실패한 메시지는 놓아 줌). 비서 답 앞에는 오너 글에 "(제가 다시 켜지는 동안 받은 메시지예요. 늦게 답해요)"가 붙은 채로 처리된다.
- 디스코드: 꺼져 있는 동안 DM에 보낸 오너 글(마지막 봇 글 뒤, 12시간 안, 최대 3개)을 켜질 때 한 번 처리한다.
- 같은 메시지는 한 번만 답한다(재시작 복구와 채널 따라잡기가 겹쳐도).
- 비서가 바로 전 답과 거의 같은 답을 하려 하면 한 번 다시 쓰게 한다.

### 18.2 초안에서 배우기·숫자 (`mail-quality`)
- 서버가 오너의 보낸편지함과 "초안을 고쳐서 보낸 것"으로 **말투 가이드**를 배운다(매주, 고친 초안이 있으면 그날). 초안 쓰기는 이 가이드를 따른다.
- 자동 초안마다 결과를 본다: 그대로 보냄(`as-is`, 단어가 90% 이상 같음)·고쳐 보냄(`edited`)·일주일 안에 안 보냄(`unsent`). 고쳐 보낸 것은 "원래 메일 / 비서 초안 / 오너가 보낸 글" 한 쌍으로 이 맥에 남아 시험 세트가 된다(가린 뒤, 최대 200개).
- `capabilities.features`에 `mail-quality`가 있으면 `GET views/mail-quality`:
  `{drafted, asIs, edited, unsent, pending, closeness?, byKind:{<kind>:{drafted, asIs}}, style?:{learnedAt, samples, edits, guide}, testCases, lastEval?:{at, cases, now, before}}` — 최근 30일.
  `closeness`는 보낸 초안이 오너 글과 얼마나 같았는지(0~1). `lastEval`은 시험 세트를 지금 방식으로 다시 써 본 점수(`now`)와 원래 초안 점수(`before`).
- 대화 도구: `mail.draft_stats`(숫자 보기), `mail.draft_eval`(시험 세트 다시 돌리기, 최대 20건).

## 19. 파일 변경·찾기·보내기

- **파일 변경 화면**(기능 `file-changes`): `capabilities.views[]`에 `{name:"file-changes", version:1, ui:"blocks", title:"파일 변경", icon:"doc.badge.clock"}`.
  `GET views/file-changes` → `{title:"파일 변경", blocks}`(§14 블록 형식).
  - `stat` "최근 7일 동안 바뀐 파일" `N건`
  - 날짜마다 `list` 하나, 새 날짜가 위: 제목 `오늘 · 3건` / `어제 · 1건` / `11월 16일 (월) · 2건`, 줄마다 `{title: 파일 이름, detail: "새로 생김|바뀜|지워짐 · ~/폴더", trailing: "HH:MM"}`(하루 30줄까지).
  - 없으면 `text` "최근 일주일 동안 바뀐 파일이 없어요.", 실시간 감시가 꺼졌으면 `note` "…한 시간마다 확인해요.", 끝에 `ask` "어제 뭐 바뀌었어?".
  - 대상은 맥에서 연결한 폴더(`connector.local-files`의 `folders`)뿐. 숨김 파일, `~/Library`, 비밀번호·키·신분증처럼 보이는 이름은 빼고, 경로는 홈 기준 `~/…`.
  - 서버는 폴더를 실시간으로 보고(macOS FSEvents, 3초 모아서) 바뀐 파일만 다시 색인. 한 시간마다 한 번 더 훑는다(놓친 변경·지운 파일 정리). 기록은 최근 500건.
- **대화 도구**(앱 변경 없음): `files.changes {since_hours?, folder?}` "어제 뭐 바뀌었어?", `files.find {query, kind?: name|content, limit?≤20}` 맥 전체(홈 안) Spotlight 검색 — 이름·`~/` 경로·크기·수정 시각만. `files.read`는 찾은 경로(`source:"home"`)의 글자 파일을 읽는다(1MB 이하, 읽기 전용).
- **폰으로 파일 보내기**: `files.share_to_app {path}`(오너 본인 앱에만, 효과 `write`). 서버가 파일을 앱 파일 폴더로 복사하고 메인 대화에 메시지 하나를 올린다:
  ```json
  {"type":"message","role":"assistant","text":"요청한 파일이에요: 계약서.pdf",
   "attachments":[{"id":"doc_<24 hex>.pdf","name":"계약서.pdf","contentType":"application/pdf","size":48213,"url":"files/doc_<24 hex>.pdf"}]}
  ```
  - 앱은 `GET files/<id>`(같은 토큰)로 원본 바이트를 받는다. `Content-Type`은 `contentType`과 같다. 30일 보관(§7.5와 같음).
  - 종류: pdf, 사진(png·jpg·gif·webp·heic), 오피스(doc·docx·xls·xlsx·ppt·pptx·hwp·hwpx), txt·md, zip. 20MB까지. 내용 첫 바이트가 확장자와 맞아야 함.
  - 앱 처리: `contentType`이 `image/*`면 지금처럼 썸네일, 그 밖은 파일 행(이름·크기, 누르면 받아서 공유 시트/미리보기). `id`가 `doc_`로 시작하면 문서.
  - 앱 채널이 없거나 앱 파일 폴더가 없으면 서버가 쉬운 말로 거절(대화로 답함).

## 20. 방법 찾기 (사이트·해 본 일·Aside 브라우저)

- 오너가 채팅으로 무언가를 하라고 했는데 맞는 도구가 없으면, 못 한다고 하지 않고 이 순서로 방법을 찾음:
  1. 오너가 쓰는 사이트(회사 툴 먼저)
  2. `web.look`: 오너가 로그인해 둔 Aside 브라우저에서 보기만
  3. `web.do`: 사이트에서 무언가 하기. 정확한 할 일을 결재 카드로 먼저 묻고, 주문·결제 말이 있으면 카드 효과에 `pay`. Aside는 결제 직전에서 멈추고 장바구니와 금액을 알려 줌.
  4. 사이트·계정·세부가 없으면 짧게 한 번 물어봄
- 오너가 "admin.example.co.kr은 회사 관리 툴이야"처럼 말하면 `ways.remember_site`로 기억하고, 다음 대화부터 그 사이트를 먼저 씀. 성공한 일은 "해 본 일"로 남아서 비슷한 요청 때 출발점이 됨.
- 화면: 블록 뷰 `ways` "알아 둔 사이트·방법"(globe).
- 켜고 끄기: `plugins["skill.ways"]`, `plugins["connector.aside"]`(기본 켜짐). Aside CLI(`~/.local/bin/aside`)가 없으면 웹 도구가 꺼지고, 비서는 어떤 사이트를 쓸지 말한 뒤 Aside 설치·로그인을 부탁함. 설정 `account`(u0…), `effort`, `timeoutMinutes`.
- 사이트에서 읽은 글은 데이터로만 다룸(인젝션 줄 제거).

## 21. 2026-11-20 ax-hq: 봇끼리 대화·방 정리·문서 검색 (오너: 봇끼리 대화가 안 보임 · 알림 방 없애기 · 문서를 못 찾음 · 3D 지도가 보기 힘듦)

모두 필드·이벤트 추가라 `protocol`은 1 그대로. ax-hq 어댑터(`src/desktop-app`) 기준. 모르는 필드·`type`은 건너뛰면 옛 앱도 깨지지 않는다.

### 21.1 `notice`는 더 안 옴 — 모든 방 글은 `message` + 작성자
- ax-hq는 `notice` 이벤트를 보내지 않는다(`capabilities.features`에서 `notices`가 빠짐). 결재·브리핑·장애·팀 방·팀장회의의 시스템 글도
  `type:"message", role:"assistant", channel, author:{id,name}`으로 온다. 작성자가 글에 없으면 방의 기본 화자: 팀 방 = 그 팀장, 결재·브리핑·팀장회의 = 비서(`id:"latte"`),
  장애 = `{id:"sre", name:"장애 알림"}`. 팀 직원 글은 `name:"Leo 팀 · 리서처"` 형태.
- **앱이 할 일**: 가운데 회색 '알림' 줄(NoticeRow)·'알림 방' 묶음·데스크톱 '브리핑·알림' 모음 방을 없앤다. 채널 없는 글은 비서 대화다(§7.2 그대로).
- 옛 기록의 `notice`(ax-hq가 보관 중인 것)는 그대로 남을 수 있다 → 그 방의 작성자 없는 글로 그리면 됨.

### 21.2 방 목록(`capabilities.channels`, `views/channels`)
- 순서: 비서(`""`, conversation) · 결재 · 팀장회의 · 팀 방들 · 브리핑 · 장애 · 개발 세션. **`로그` 방은 없어짐**(로그성 글은 앱에 안 보냄).
  브리핑·장애·개발 세션은 글이 하나라도 있을 때만 나온다. `views/channels`에서 팀 방은 마지막 글이 최신인 순.
- 이름은 짧은 한국어: 기획·개발·품질 검사·디자인·인프라·보안·법무·재무·고객 문의·마케팅·영업·투자·크리에이터·신뢰안전. 방 id(`channel`)는 그대로(`pm`, `개발`, `qa` …).
- 항목 필드: `{id, label, kind:"conversation"|"channel"|"team", writable?, group:"개인"|"대표실"|"<회사>"|"개발", lead?:{id,name}}`.
  `팀장회의`는 `writable:true`(쓰면 최근 회의 의장이 받음, 회의가 없으면 PM). `views/channels`는 더해서
  `lastSeq, count, lastAt?, preview?(마지막 글 80자), lastAuthor?, readSeq, unread`.
- **앱이 할 일**: '알림 방' 섹션 대신 이 목록 그대로(묶음 `group`으로 머리글). 팀 방은 `views/bots`와 같은 방이다(`channel`이 같음).

### 21.3 봇끼리의 대화
- **팀장 ↔ 팀장**(A2A 질문·답·검토·넘김): `message`에 `author`(말한 팀장) + `to:{id,name}`(들은 팀장). 묻는 팀의 방(또는 그 작업의 스레드)에 둘 다 온다.
  글은 그대로의 말(디스코드식 "💬 Nora → Mia · 검토 요청:" 머리말은 빠짐, 승인이면 "✅ 승인해요. …", 거절이면 "⛔ 거절할게요. …").
- **작업 스레드**(`thread`): 팀 작업 하나, PM 파이프라인 단계(제안→개발→QA) 하나, 회의 하나, 위원회 하루 기록 하나가 각각 스레드다.
  `thread:{id, title, start?:true}` — `start`인 첫 줄은 팀장이 여는 말("「로그인 화면 다시 확인」 맡았어요.", 회의는 "[스탠드업] 11/20(금)…"), 그 뒤 줄들
  (📋 계획, ✅ 1/3 단계, ↩️ 다시, 🏁 결과, ➡️ 넘김, 위원회 판단)은 같은 `thread.id`. 스레드 id는 `app-th-…`·`app-meeting-…`.
  - **앱이 할 일**: 방에서는 스레드의 첫 줄 + "답글 n개 · 마지막 줄 미리보기"로 접고, 누르면 펼침(또는 시트). `GET events?thread=<id>`로 그 스레드 줄만 받을 수 있다.
    스레드 없는 줄은 평소처럼.
- **위임**(§8 R2 `delegation`): 비서가 팀에 맡긴 일은 비서 대화에, 팀장이 다른 팀에 넘긴 일은 넘긴 팀 방에
  `{type:"delegation", bot:{id,name}(맡은 팀장), botChannel, task, state:"started"|"done"|"failed", summary?, channel?, author?(넘긴 팀장)}`. 시작·끝 한 번씩.
- 팀장회의(스탠드업·주간·안건)는 팀장회의 방의 스레드로, 팀장마다 `author`가 붙은 줄. 비서 정리 줄은 `author` 비서.
- 이런 대화 줄(`to` 있음, `thread` 줄, 팀 방 잡담)은 **푸시하지 않는다**. 푸시는 비서 대화, 결재·장애·브리핑 글, 오너 글에 대한 팀장 답만(서버 전용 표시 `alert`).

### 21.4 반응·읽음
- 반응: `POST messages/<seq>/react {emoji}`(§7.4)이 이제 이벤트도 남긴다 → `{type:"reaction", target:<seq>, emoji, by:{id,name}, channel?}`.
  팀장이 전체 공지에 단 반응도 같은 이벤트(예전처럼 "👍"만 있는 줄은 안 옴). 앱은 `target` 글 아래에 이모지·수를 모아 보여 준다.
- 읽음 동기화(기능 `read-sync`): `POST read {channel, upTo}` → `{ok, changed}`. 서버가 `{type:"read", channel?, upTo}` 이벤트를 남겨
  다른 기기도 그 방의 안 읽음 표시를 지운다. 오너가 그 방에 쓴 글도 그 seq까지 읽은 것으로 친다. `views/channels`의 `readSeq`·`unread`가 그 값.
- 새 `features`: `threads`, `delegation`, `bot-talk`, `read-sync` (그리고 `notices` 없음).

### 21.5 서버가 정리해서 보내는 글
- 디스코드 문법(`<@id>`, `<#id>`, `<:emoji:id>`, `-#`, `||…||`, `:white_check_mark:`), `<t:…>`·ISO 시각(→ "11/20 07:00" KST), 작업·결정 UUID,
  "task `2a012f66`", "#승인 카드에서 버튼으로 결정합니다" 같은 디스코드 안내는 빠져서 온다. 같은 방의 같은 시스템 글은 6시간에 한 번.
- 결재 카드 `summary`는 결정 내용("깃허브 11월 예산 상향 승인")이고, 예전 머리글("🗳️ 결재 · 재무·회계")은 `note` 끝에 괄호로.
- 앱에 안 보내는 것: `로그` 방 글, 하루 알림 예산 초과분 묶음("🗂️ 오늘 묶어 둔 알림 …"), 지식 개수 줄, 문제 없이 끝난 QA 기록.
- 기록 보관: 최근 3000개(비서 대화는 그중 절반까지 보호, 열린 카드는 안 지움).

### 21.6 문서 검색·문서 목록 (`views/knowledge`)
- 목록 `GET views/knowledge` → `{updatedAt, areas:[{id, label, total, docs:[{id,title,lines,updatedAt}]}]}`. 분야: 개요·회사·회사 운영·회사 문서·
  **회사 기록**·**팀 위키**·운영·개인·**AX 문서**(굵은 것은 새로 들어감). 분야마다 최신순 300개까지(`total` = 전체 수, 나머지는 검색으로).
- 검색 `GET views/knowledge?q=<말>[&area=<분야 id>][&limit=1..100, 기본 30]` → 
  `{query, words, total, results:[{id, title, area, areaLabel, path, updatedAt, score, line, snippet, highlights:[[시작,끝)], titleHighlights, matches}]}`.
  제목·본문·분야·경로 전체를 한국어 부분 일치(대소문자 무시)로 찾고, 띄어쓴 말은 모두 들어 있어야 함, `"따옴표"`는 한 말. `line`은 가장 잘 맞는 줄(1부터, 0 = 제목만 맞음),
  `snippet`은 그 줄 앞뒤 일부, `highlights`는 snippet 안 글자 위치. 처음 한 번 1~2초, 그다음은 수 ms.
- 문서 `GET views/knowledge?doc=<id>[&q=<말>]` → `{document:{name,title,kind,markdown,lines:[], matches?:[{line, ranges}]}}`. `markdown`에는 front matter·
  `<!-- … -->` 표시가 빠져 있고 `matches.line`은 그 markdown의 줄 번호.
- **앱이 할 일**: 문서 탭 검색창은 이 `q`로 서버에 묻는다(제목만 거르던 로컬 검색 대신), 결과는 제목·분야·snippet 하이라이트, 누르면 `doc=&q=`로 열고 첫 `matches` 줄로 스크롤.

### 21.7 문서 지도(`views/docgraph`)의 목록형
- 기존 `layers`·`nodes`·`links`에 더해 `tree:[{id(층), label, summary?, count, items:[{id, title, summary?, updatedAt?, related:[{id,title,label}](8개까지)}]}]`.
  층(사람·회사·프로젝트·주제·…·문서) → 항목 → 관련 항목. 서버는 좌표를 주지 않는다(원래도 없음).
- **앱이 할 일**: 3D/우주 화면 대신(또는 기본 화면으로) `tree`를 접히는 목록으로: 층 머리글 → 항목 행(제목·요약) → 누르면 `?doc=<id>`, 관련 항목은 칩.

## 22. 브라우저 화면 넘겨받기 (`browser-live`)

브라우저 심부름(`browser.task`)이 로그인·캡차·약관 동의·마지막 버튼에서 멈추면, 오너가 앱에서 그 페이지를 보고 직접 누르고 써서 끝낸 뒤
'다 했어요'로 비서에게 이어 가라고 한다(맥 화면 공유가 필요 없음). 필드·경로 추가라 `protocol`은 1 그대로.

- **있을 때만**: `capabilities.features`에 `"browser-live"`, `capabilities.views[]`에
  `{name:"browser-live", version:1, actions:["start","tap","type","key","scroll","back","done"]}`. Playwright 어댑터일 때만 생긴다
  (브라우저 에이전트 CLI 어댑터·브라우저 꺼짐이면 없음 → 앱은 화면을 숨긴다).
- **언제 열 수 있나**: 서버가 넘길 페이지를 정했을 때만 — `browser.task`가 `needs_human`으로 멈췄을 때, 또는 오너가 "그 페이지 열어 줘"라고 해서
  `browser.open_for_me`(기본 `on:"app"`)가 돌았을 때. 그 상태가 `pending`이고(60분 유효), 앱이 `start`를 보내야 실제 페이지가 열린다.
  앱이 임의의 주소를 열 수는 없다. 비서(모델)는 이 페이지를 조작하지 못한다 — 조작은 오너 앱의 요청뿐.
- **대화에서 알아보기**: 그 턴의 비서 답(`message`, `role:"assistant"`)에 필드가 붙는다:
  `"live":{"view":"browser-live","reason":"login","url":"https://shop.example.com/login"}`
  (`reason`: `login|payment|consent|captcha|other`, `url`은 알 때만). 앱은 `capabilities`에 `browser-live`가 있고 이 필드가 있으면
  그 글 아래에 '브라우저 화면 열기' 버튼을 보여 준다(언제든 더보기 메뉴에서도 열 수 있게). **필드를 먼저 본다** — 안내 문장
  "앱의 브라우저 화면에서 직접 하실 수 있어요…"를 글에서 찾는 방식은 `live`가 없는 옛 서버용 대비책으로만 남겨 둔다(모델이 문장을
  바꿔 쓸 수 있어 놓칠 수 있음). 봇 방(`channel`)의 답에도 붙는다. 팀장이 팀에 나눠 맡긴 답(팀 방, 팀장 봇 방)에도 붙는다 — 팀원 누구든 마지막으로 남긴 페이지가 팀장 답으로 올라온다. 메인 대화에서 봇에게 맡긴 일(`bots.delegate`)이면 메인 대화의 비서 답에 붙는다. 디스코드 등 다른 채널은 이 필드를 쓰지 않는다.
  화면을 열면 `GET views/browser-live`를 읽고 `pending`이 있으면 바로 `start`를 보낸다.

### 22.1 상태 `GET views/browser-live`

```jsonc
{"ok":true,"view":"browser-live","version":1,"data":{
  "live":true,
  "url":"https://shop.example.com/login","title":"로그인",
  "reason":"login",                       // login|payment|consent|captcha|other
  "startedAt":"2026-11-20T03:10:00.000Z",
  "idleClosesAt":"2026-11-20T03:25:00.000Z",
  "frameUrl":"browser-live/frame","streamUrl":"browser-live/stream"}}
```
열린 페이지가 없을 때: `{"live":false, "pending"?:{"url","reason","at"}, "closed"?:"done"|"idle"|"stopped"|"error"|"shutdown", "frameUrl","streamUrl"}`
(`closed`는 직전 세션이 끝난 까닭, 다음 세션이 열리면 사라짐).

### 22.2 화면 그림
- **스트림(권장)** `GET browser-live/stream`(SSE, 같은 토큰. 기기당 스트림 3개 한도에 들어감 — 화면을 떠나면 닫을 것). 요청 상한(분당 60)을 쓰지 않는다.
  - `event: state` / `data: <22.1의 data와 같은 모양, frameUrl·streamUrl 빼고>` — 연결 직후 한 번, 그 뒤 열림·닫힘마다.
  - `event: frame` / `data: {"seq":1,"url":"…","title":"…","width":824,"height":1720,"jpeg":"<base64 JPEG>"}` — 0.7초마다 보고 **바뀌었을 때만** 보냄.
    `id:` 줄은 없다(다시 연결하면 지금 그림부터).
- **한 장씩** `GET browser-live/frame` → `200 image/jpeg`(원본 바이트), 열린 페이지가 없으면 `404 {"ok":false}`. 이것도 일반 요청이라
  분당 60 상한에 들어가니 폴링은 2초 이상 간격으로(스트림을 쓸 수 없을 때만).
- 그림은 폭 412·높이 860 CSS 픽셀 페이지를 2배로 그린 JPEG(지금 824×1720). **좌표는 항상 이 JPEG의 픽셀**(왼쪽 위 0,0) — 앱이 화면에 맞춰 줄이거나
  확대해 보여 주더라도 보낼 때는 JPEG 픽셀로 바꿔 보낸다. 크기는 `frame` 이벤트의 `width`·`height`(또는 JPEG 자체 크기)를 쓴다.
- 새 탭으로 열리는 링크는 그 탭이 그림이 되고, 탭이 닫히면 앞 탭으로 돌아온다.

### 22.3 조작 `POST views/browser-live/<action>`
| action | 본문 | 답 `data` |
|---|---|---|
| `start` | `{}` | 22.1의 data(`live:true`). 넘길 페이지가 없으면 400 `message` "지금 열어 드릴 브라우저 화면이 없어요.", 브라우저가 다른 일 중이면 400 "브라우저가 다른 일을 하는 중이라…" |
| `tap` | `{"x":412,"y":300}` (JPEG 픽셀, 숫자) | `{"accepted":true}` |
| `type` | `{"text":"…"}` (1~1000자) | `{"accepted":true}` — 지금 포커스된 칸에 친다(먼저 칸을 `tap`) |
| `key` | `{"name":"Enter"}` — `Enter`·`Backspace`·`Tab`·`Escape`·`ArrowUp`·`ArrowDown`·`ArrowLeft`·`ArrowRight` | `{"accepted":true}` |
| `scroll` | `{"dy":800}` (JPEG 픽셀, 아래로 +, 한 번에 ±4000으로 자름) | `{"accepted":true}` |
| `back` | `{}` | `{"accepted":true}` (뒤로 가기) |
| `done` | `{}` | 22.1의 data + `"resumed":true\|false`, 이어 갔으면 `"continuedIn":"app"\|"elsewhere"`, 방이면 `"channel":"<방 id>"` |

- 열린 페이지 없이 `tap`·`type`·`key`·`scroll`·`back` → `400 {"ok":false,"error":"shape","message":"브라우저 화면이 닫혀 있어요. 비서에게 다시 열어 달라고 해 주세요."}`.
  모양이 틀리면 `400 {"error":"shape"}`(message 없음). 좌표는 그림 안으로 맞춰진다.
- 초당 8번 넘게 조작하면 그 조작은 버리고 `{"accepted":false,"retryAfterMs":250}`. 글자는 한 글자씩이 아니라 **칸 하나를 다 쓴 뒤 한 번에** `type`으로
  보낸다(분당 60 요청 상한 안에서). 조작 뒤 그림은 스트림의 다음 `frame`으로 온다.
- `done`: 페이지를 닫고(같은 프로필이라 로그인은 다음 심부름에 남음) 넘김을 지운다. 열려 있었거나 넘길 페이지가 있었으면(`resumed:true`) 서버가
  **심부름을 시킨 대화에** 오너 글 하나를 남기고 비서에게 넘긴다:
  `{"type":"message","role":"owner","text":"(앱의 브라우저 화면에서 직접 마쳤어요: shop.example.com) 계속해 주세요."}` → 비서가 하던 심부름을 이어 간다.
  - 앱 메인 대화에서 시켰으면 메인 대화(`continuedIn:"app"`), 봇 방·팀 방에서 시켰으면 그 방(`channel`이 붙은 글, 답의 `channel`도 그 방).
    앱은 `done` 뒤 그 대화(방) 화면으로 돌아가면 된다.
  - 디스코드에서 시켰으면 오너 글은 디스코드의 그 대화로 넘어가고 비서 답도 거기로 간다(`continuedIn:"elsewhere"`). 디스코드 그 대화에는 비서 답보다 먼저
    짧은 줄 "(앱의 브라우저 화면에서 직접 마쳤어요: shop.example.com) 이어서 할게요."가 보인다(오너가 친 글자는 들어가지 않음). 앱 메인 대화에는
    `notice` "브라우저 화면에서 마친 일은 디스코드 대화에서 이어 갈게요."만 남는다.
  - 그 대화로 보낼 수 없으면(루틴이 시킨 일, 꺼진 채널) 앱 메인 대화(봇의 일이면 그 봇 방)로 가고, 글 끝에
    "(처음 시킨 대화로는 보낼 수 없어서 여기서 이어 가요.)"가 붙는다.

### 22.4 저절로 닫힘·안전
- 조작이나 그림 요청이 15분 없으면, 연 지 60분이 지나면, 비상 정지(R10)가 켜지면, 서버가 멈추면 닫힌다(`state` 이벤트 `live:false, closed:"idle"|"stopped"|"shutdown"`).
- 열려 있는 동안 브라우저 프로필은 이 화면이 쓴다: 다른 심부름·`browser.read`는 "앱에서 열려 있어요"로 거절되고, 닫히면 풀린다.
- **페이지를 그대로 이어받음**: `browser.task`가 멈추면 서버는 그 페이지를 닫지 않고 15분까지 열어 둔다. 그 사이 `start`하면 심부름이 멈춘
  바로 그 페이지(이미 채운 칸 그대로)가 열린다 — 다시 불러오지 않는다. 15분이 지났거나, 그 사이 다른 심부름·`browser.read`·맥 창이 프로필을 써야
  했거나, 비상 정지가 켜졌거나, 오너가 화면을 열지 않고 `done`을 눌렀으면 그 페이지는 닫히고, `start`는 같은 주소를 새로 연다(로그인은 프로필에 남음).
  앱이 할 일은 같다. `browser.open_for_me`로 연 페이지는 늘 새로 연다.
- 오너가 친 글자(`type`)는 페이지로만 간다 — 서버 로그·작업 기록·실행 기록(trace)·채팅 기록·모델 프롬프트 어디에도 남지 않는다. `done` 글에도 들어가지 않는다.
- 앱 토큰(오너가 짝지은 기기·데스크톱 로컬 토큰)으로만. 비밀번호 칸에 쓰는 것은 오너 자신이고, 결제도 오너가 직접 누른다.

## 23. 프로젝트 가져오기 (`projects`)

처음 알아보기가 어떤 프로젝트를 읽고, 회사 → 프로젝트 지식 문서와 봇 팀을 무엇으로 만들지 오너가 고르는 화면이다. `capabilities.features`에
`projects`가 있으면(처음 알아보기를 켠 서버) 보인다. 서버가 찾는 곳: setup에서 고른 폴더의 git 저장소, 이 컴퓨터의 Claude Code
(`~/.claude/projects`)·Codex(`~/.codex`) 대화 기록이 작업한 폴더(워크트리는 원래 저장소로 묶임). 모두 읽기만 한다.

### 23.1 `GET views/projects` (`?refresh=1`이면 다시 찾음, 아니면 10분 동안 같은 목록)
```json
{
  "companies": [
    {
      "name": "에이컴퍼니",
      "projects": [
        { "path": "/Users/me/dev/acme/web", "display": "~/dev/acme/web", "name": "acme-web", "company": "에이컴퍼니",
          "remote": "github.com/acme/acme-web", "lastActive": "2026-11-20T03:00:00.000Z", "claude": 12, "codex": 3, "picked": true }
      ]
    }
  ],
  "picked": 4,
  "scan": { "status": "idle|running|paused|done|failed", "phase": "local|projects|drive|signals|profile|done",
            "counts": { "files": 0, "repos": 0, "docs": 0, "sessions": 0, "drive": 0, "summarized": 0, "signals": 0 },
            "finishedAt": "…" }
}
```
- 회사는 최근에 작업한 순서, 회사 안의 프로젝트도 최근 순서. `company`·`name`은 오너가 고친 이름이 우선(처음엔 GitHub 조직 이름이나 상위 폴더 이름으로 추측).
- `claude`·`codex`는 그 프로젝트에서 찾은 대화 수. `lastActive`가 없으면 예전에 골랐지만 지금은 찾지 못한 폴더다(빼기만 할 수 있게 남겨 둠).
- `scan.status:"running"`이면 지금 읽는 중이다. 처음 한 번은 꼼꼼히 다 읽어서 몇십 분~몇 시간 걸릴 수 있다(진행 알림은 대화창 `notice`로 온다).

### 23.2 `POST views/projects/save`
```json
{ "projects": [ { "path": "/Users/me/dev/acme/web", "name": "acme-web", "company": "에이컴퍼니" } ], "rescan": true }
```
- 고른 **전체 목록**을 보낸다(빠진 것은 빠짐). 최대 200개, `name`·`company`는 1~80자. 회사 이름 바꾸기·다른 회사로 옮기기도 이걸로 한다.
- `path`는 23.1 목록에 있던 것만 된다. 다른 경로면 `400 {"error":"shape","message":"찾은 목록에 없는 폴더예요. 목록을 새로 고친 뒤 골라 주세요."}`.
- 답: `{"saved":4}`. `rescan:true`면 바로 다시 읽기 시작하고 `"scan":"started"`(이미 읽는 중이면 `"running"`)가 붙는다. 아니면 다음 날 새벽 정기 확인 때 읽는다.
- 저장한 목록은 setup에서 고른 것보다 우선한다.

### 23.3 `POST views/projects/refresh` `{}`
23.1과 같은 답을 다시 찾아서 준다(새로 만든 저장소나 새 대화 기록을 바로 보이게).

### 23.3a 2026-11-23: 직업을 가리지 않는 일 지도
- 후보에는 코드 저장소만이 아니라 **문서가 모인 폴더**도 나온다(`~/Documents/브랜드A 리뉴얼`처럼 집 폴더 두 단계 아래, 최근 2년 문서 5개 이상). 그런 후보는 `"docs": 23`이 붙고 `claude`·`codex`는 0.
- 다 읽은 뒤 "일 지도"를 만든다: 직업·한 줄 소개, 일하는 곳(다니는 곳·내 사업·고객사·협력사·개인), 곳마다 프로젝트, 프로젝트마다 반복하는 일과 필요한 역할.
  고른 프로젝트는 오너가 정한 회사 그대로, 아무것도 안 골랐으면 폴더에서 프로젝트를 만든다.
- 지식 문서: 프로젝트 문서에 "반복하는 일"·"팀 역할" 섹션이 더해지고, 프로필에 직업 줄과 회사마다 "(다니는 곳): 프로젝트들" 줄이 생긴다.
- 봇: 회사 = 그룹, 프로젝트 = 팀. 직원 봇은 "직원 1·2·3"이 아니라 그 프로젝트의 역할 이름·하는 일로 만들어진다(예: "브랜드A 리뉴얼 레퍼런스 조사" — 비슷한 브랜드 사례를 모아요). 코드 일이면 개발팀(검수 포함), 아니면 일반 팀.

### 23.4 읽은 뒤 생기는 것
- 지식 문서: `프로젝트/<회사>/README.md`(회사의 프로젝트 목록)와 `프로젝트/<회사>/<프로젝트>.md`. 프로젝트 문서에는 목적·상태·기술·도구·정한 것·
  남은 일·최근 활동·사람·관련 파일이 들어간다(저장소·문서·대화 기록 요약에서, 비밀값·이메일·전화번호는 가린 뒤). 기존 `knowledge-docs` 화면에 그대로 보인다.
- 봇: 회사마다 그룹 하나와 "<회사> 업무" 팀, 고른 프로젝트마다 그 회사 그룹 안에 개발팀(리뷰어 포함)이 생긴다(최대 24팀, 이미 있는 이름은 그대로 둠).
  기존 `bots` 화면에 그대로 보인다.

## 24. 팀 구조 미리보기 (`team-plan`)

처음 알아보기가 회사 → 프로젝트 구조(일 지도·고른 프로젝트)를 찾으면 서버는 팀을 바로 만들지 않고 **제안서**를 만든다. 오너에게는 카드 하나가 간다:
"일 지도대로 이렇게 팀을 만들까요?" + 나무 모양 미리보기(■ 회사 / · 팀 — 직원 역할 / ↻ 루틴), 선택지 `build`(이대로 만들기)·`fix-in-app`(앱에서 고칠게요, 7일 뒤 다시 물음 — 앱은 이 버튼을 서버에 보내지 않고 팀 구조 화면만 열어도 됨)·`no`(만들지 않기).
`capabilities.features`에 `team-plan`이 있으면 앱에서 고칠 수 있다.

### 24.1 `GET views/team-plan`
```json
{ "plan": { "id": "p…", "createdAt": "…", "status": "proposed|applied|declined", "appliedAt": "…",
  "teams": [ { "company": "스튜디오 오름", "name": "브랜드A 리뉴얼", "purpose": "로고·가이드 개편", "kind": "general|dev",
               "roles": [ { "title": "레퍼런스 조사", "does": "비슷한 사례를 모아요" } ],
               "tasks": [ "주간 시안 진행 점검" ],
               "routines": [ { "title": "시안 진행 점검", "instruction": "이번 주 시안 진행 상황을 정리해 알려 줘",
                               "schedule": { "kind": "weekly", "day": "mon", "at": "09:30" } } ] } ] } }
```
제안서가 없으면 `{"plan": null}`. `roles`가 그 팀의 직원 봇이 된다(최대 6, `title` 1~20자). 개발팀(`dev`)은 검수 봇이 붙는다. `tasks`는 참고용(일 지도의 반복하는 일), `routines`는 만들 때 그 팀 팀장에게 맡길 루틴(팀마다 최대 5).
`schedule`은 `{"kind":"daily","at":"HH:MM"}` | `{"kind":"weekly","day":"mon..sun","at":"HH:MM"}` | `{"kind":"every","hours":1..24}`.

### 24.2 `POST views/team-plan/save` `{ "teams": [ …24.1의 teams 모양 그대로… ] }`
고친 **전체 목록**을 보낸다(팀 빼기·회사 이름 바꾸기·역할·루틴 고치기 모두 이걸로, 최대 24팀). `status`가 `proposed`일 때만 된다(아니면 400 `no proposed plan`). 답 `{"saved": n}`.

### 24.3 `POST views/team-plan/apply` `{}` · `POST views/team-plan/decline` `{}`
- `apply`: 그룹·팀·봇을 만들고 루틴을 팀장에게 건다. 답 `{"teams": 만든 팀 수, "routines": 만든 루틴 수}`, 이미 만든 제안서면 `{"teams":0,"routines":0}`. 끝나면 `notice` "팀 N개와 루틴 M개를 만들었어요."
  이미 있는 이름의 그룹·팀은 그대로 둔다. 만든 뒤에는 기존 `bots`·루틴 화면에서 고친다.
- `decline`: 제안서를 버린다. 답 `{"declined": true|false}`.

## 25. 생활 심부름 (`skill.errands`, 2026-11-23)

선택 플러그인(기본 꺼짐, `ax-kit setup`의 '생활 심부름'). 새 화면·엔드포인트는 없고, 기존 카드·답·알림에 실려 온다. `protocol`은 1 그대로.

- **카드**: 도구 `errands.train`(KTX·SRT)·`errands.restaurant`(네이버 예약·캐치테이블)·`errands.shop`(장바구니)·`errands.seat_watch`(빈자리 감시)는
  매번 승인 카드가 뜬다(`note`가 늘 붙고 "앞으로는 그냥 해" 제안(`remember`)은 없음). 카드 `summary`에 무엇을 어디까지 할지가 적힌다.
- **멈춤**: 기차는 예매 버튼 앞, 식당은 [예약하기] 앞, 쇼핑은 장바구니에서 멈춘다. 결제·카드 번호·비밀번호·로봇 확인은 하지 않는다. 오너가 채팅에서
  "눌러도 돼"라고 하면 기차만 그 좌석 버튼 하나를 눌러 좌석을 잡고 결제 화면에서 다시 멈춘다(새 카드). 식당에 예약금·선결제가 있거나 취소 규정이
  분명하지 않으면 누를 버튼을 주지 않고 묻는다.
- **답의 `live`**: 멈춘 페이지는 §22와 똑같이 비서 답의 `live` 필드(`{"view":"browser-live","reason":"other"|"payment"|"login"|…,"url"}`)로 온다.
  쇼핑은 장바구니 페이지가 `reason:"payment"`로 온다. 앱은 '브라우저 화면 열기' 버튼을 그대로 보여 주면 된다.
- **알림** (`notice`): `kind:"errands.seat"` — 감시하던 기차에 빈자리가 났어요(급한 알림, 조용한 시간에도 감, 예매는 하지 않음).
  `kind:"errands.seat_watch"` — 감시가 끝났거나(최대 24시간), 로그인·로봇 확인이 떠서 멈췄거나, 조회가 세 번 실패해 멈춤.
  빈자리 감시는 10~60분 간격(기본 15분)으로만, 서버 전체에서 5분에 한 번보다 자주 조회하지 않고, 한 번에 2개까지.
- 가격 감시(`watch.alert`)가 목표가에 닿았고 이 플러그인이 켜져 있으면 알림 끝에 "장바구니에 담아 둘까요?" 한 줄이 붙는다.

## 26. 문자 읽기 (`skill.sms-reader`, 2026-11-23)
새 전송 경로는 없다. 휴대폰 자동화가 지금처럼 `POST /m/v1/ingest`에 `{"kind":"sms","from":…,"text":…,"at":…}`를 보낸다. `plugins["skill.sms-reader"].enabled = true`일 때만 켜지고(기본 꺼짐), 켜면 `skill.chat-inbox`의 문자 약속 찾기(`sms`) 대신 이 기능이 문자를 맡는다.
- 코드 규칙 먼저(택배사·운송장 번호, 청구·납부 금액과 기한, 예약 확정·변경·취소와 날짜·시간·장소), 규칙이 애매할 때만 가림 처리한 `fast` 모델 한 번(`plugins["skill.sms-reader"].model = false`면 규칙만).
- 앱이 받는 것은 기존 카드·알림 그대로다. 카드는 문자 하나·종류 하나에 한 번(`topic` = `sms:reservation:<id>` · `sms:bill:<id>` · `sms:parcel:<id>`), 선택지 `yes`·`later`·`no`, "앞으로 묻지 않기"(`remember`) 포함. 예 → 캘린더 일정(문자 속 날짜 인용) · 할 일(기한·금액) · 택배 따라가기(`life.parcel`, `parcelCheckMinutes` 기본 120분마다 바뀌면 알림 `sms.parcel`). 결제·삭제는 하지 않는다. 예약 취소 문자는 알림만.
- 스미싱 의심(짧은·이상한 링크, 은행·택배·기관 흉내 주소, `.apk`·앱 설치, 주소 확인·과태료·미납 같은 유도, 기관을 사칭하는 개인·해외 번호, 가짜 결제 승인 전화 유도)은 알림 `kind: "phone.smishing"` 하나만: "⚠️ 스미싱 의심 문자예요…" + 이유 + 점을 `[.]`로 바꾼 주소. 링크는 열지 않고, 그 문자로는 카드·일정·할 일을 만들지 않으며, 지출 기록에도 넣지 않는다.

## 27. 처음 알아보기 진행·결과·말로 고치기 (`first-look`, 2026-11-23)

처음 알아보기가 파일을 읽는 동안의 진행 막대, 끝난 뒤 "당신은 이런 사람이고, 이런 조직 분류가 필요해 보여요" 화면, 그리고 오너가 말로 고치는 흐름.
`capabilities.features`에 `first-look`이 있으면 쓸 수 있다. 터미널(`ax-kit setup` 마지막 단계, `ax-kit onboarding status|review`)도 이 화면을 이 맥의 로컬 토큰(`desktop.token`)으로 그대로 쓴다. §24의 카드·`team-plan` 화면은 그대로 있다(같은 제안서를 본다).

### 27.1 `GET views/first-look` (1초에 한 번 불러도 되는 가벼운 응답)
```json
{ "status": "idle|running|paused|done|failed", "phase": "local|projects|drive|signals|profile|done",
  "phases": [ { "id": "local", "label": "폴더 파일", "done": 120, "total": 400, "state": "waiting|active|done" },
              { "id": "projects", "label": "프로젝트 문서·대화 기록", "done": 12, "total": 40, "state": "active" }, … ],
  "counts": { "files": 120, "repos": 2, "docs": 30, "sessions": 12, "drive": 0, "signals": 0, "summarized": 90 },
  "percent": 42, "startedAt": "…" | null, "finishedAt": "…", "error": "model_unavailable",
  "result": { "about": "개발자 겸 운영자. 작은 쇼핑몰을 운영해요",
              "companies": [ { "name": "에이컴퍼니", "relation": "employer|own|client|partner|personal",
                               "projects": [ { "name": "베타랩", "purpose": "학습 플랫폼",
                                               "team": { "kind": "dev|general", "roles": [ { "title": "개발", "does": "기능을 만들어요" } ] },
                                               "routines": [ { "title": "주간 점검", "when": "매주 월 09:00", "schedule": { "kind": "weekly", "day": "mon", "at": "09:00" } } ] } ] } ],
              "plan": { "id": "p…", "status": "proposed|applied|declined" } | null } }
```
- `phases`는 늘 다섯 개, 이 순서(`local`·`projects`·`drive`·`signals`·`profile`). 읽을 것이 없는 단계는 `total: 0`이고 지나가면 `state: "done"`.
  막대는 `percent`(서버가 단계별 무게로 계산, `done`일 때만 100)를 그대로 그리고, 숫자 줄은 `total > 0`인 단계의 `label done/total`을 ` · `로 잇는다. 경과 시간은 `startedAt`(끝났으면 `finishedAt`까지)으로.
- `paused`: 오너가 멈췄거나 서버가 재시작돼 멈춘 상태("알아보기 계속"으로 이어 감). `failed`면 `error`가 붙는다. `idle`은 아직 한 번도 시작하지 않음.
- `result`는 `status`가 `done`이거나 아직 만들지 않은 제안서(`plan.status: "proposed"`)가 있을 때만 붙는다.
  `about`은 일 지도의 직업·한두 문장(없으면 지식 베이스 요약), `companies`는 §24 제안서(`team-plan`)를 회사별로 묶은 것(`relation`은 일 지도의 회사 관계, 모르면 `employer`). 회사·프로젝트를 못 찾았으면 `companies: []`, `plan: null`.

### 27.2 `POST views/first-look/revise` `{ "text": "아니, 에이컴퍼니랑 베타랩은 따로야. 쇼핑몰 앱은 베타랩 아래" }` (1~500자)
오너 말 그대로 보낸다. 서버가 모델 한 번(`standard`)으로 고칠 목록을 만들고, 코드가 검사해 **제안서에만** 적용한다:
회사 나누기·합치기·이름 바꾸기, 프로젝트를 다른 회사로 옮기기·이름 바꾸기·빼기, 역할·루틴 더하기·빼기, 회사 관계·팀 종류 바꾸기.
계획에 없는 프로젝트는 오너가 이름을 직접 말했을 때만 더한다. 새 회사 이름도 오너가 말한 이름이거나 원래 있던 프로젝트 이름이어야 한다. 한도는 §24와 같다(24팀, 역할 6, 루틴 5).
```json
{ "text": "이렇게 바꿨어요: 베타랩 → 베타랩 (따로 나눔), 쇼핑몰 앱 → 베타랩 아래로. 이건 그대로 뒀어요: 비밀 프로젝트 (말씀하신 적 없는 프로젝트라 만들지 않았어요).",
  "changed": [ "베타랩 → 베타랩 (따로 나눔)", "쇼핑몰 앱 → 베타랩 아래로" ], "skipped": [ "…" ], "result": { …27.1의 result… } }
```
- 앱은 `text`를 한 줄로 보여 주고 `result`로 나무를 다시 그린다. 바꿀 것을 못 찾았거나 모델이 실패해도 200이고 `changed: []`와 안내 `text`가 온다.
- 제안서가 없거나 이미 만들었으면 400 `{"error":"shape","message":"고칠 팀 구조 제안이 없어요. …"}`.
- **문서도 따라간다**: 회사가 바뀐 프로젝트는 지식 베이스에서 그 프로젝트의 `company` 줄을 오너 수정(`correction`)으로 바꾼다. 그래서 프로젝트 문서가 바로 새 회사 폴더(`프로젝트/<회사>/<프로젝트>.md`)로 옮겨지고,
  다음 알아보기가 옛 회사로 되돌리지 않는다. 프로젝트 이름 바꾸기는 팀 이름에만 쓰이고 문서 제목은 그대로다(나중에 옮겨도 원래 문서를 찾아 따라간다).
- 대화창에서도 같다: 오너가 "에이컴퍼니랑 베타랩은 따로야"라고 하면 비서가 도구 `bots.revise_plan {instruction}`(`write`)을 부르고 답에 새 나무를 보여 준다.

### 27.3 `POST views/first-look/apply` `{}` · `POST views/first-look/start` `{}`
- `apply`: §24.3 `team-plan/apply`와 같다(이대로 만들기). 답 `{"teams": n, "routines": m}`.
- `start`: 알아보기가 돌고 있지 않으면 시작한다. 답 `{"scan": "started|running"}`. 처음 알아보기가 꺼져 있으면 400.

### 27.4 터미널
`ax-kit setup`에서 "네, 바로 시작"을 고르고 7단계에서 서비스를 켜면, 요약 화면 뒤에 같은 진행 막대(단계 이름, 막대와 %, `폴더 파일 120/400 · 프로젝트 문서·대화 기록 12/40`, 경과 시간)를 보여 준다.
Ctrl+C나, 5분 넘게 남았을 때 한 번 묻는 "백그라운드로 두고 끝내기"는 알아보기를 서버에서 계속 돌게 두고 끝낸다. 끝나면 결과와 나무를 보여 주고 `이대로 만들기 / 말로 고치기 / 앱에서 나중에`를 묻는다.
`ax-kit onboarding status`는 같은 막대(파이프면 한 줄짜리 글)와 결과, `ax-kit onboarding review`는 막대 → 결과 → 고치기 반복.

## 28. 하고 있는 일 (`work`, 2026-11-23)

오래 걸리는 일(개발 작업 `dev.start`, 브라우저 심부름 `browser.task`, 생활 심부름 `errands.train`·`errands.restaurant`·`errands.shop`)은 이제
대화 턴 안에서 기다리지 않는다. 승인 카드 다음에 비서 답이 바로 "시작했어요. 끝나면 알려드릴게요. (작업 <id>)"로 오고(다른 일이 돌고 있으면
"지금 하던 일이 N개 있어서 그다음 순서로 해 둘게요"), 결과는 나중에 대화창 `notice`로 온다. `protocol`은 1 그대로.

- **알림** (`notice`, 오너가 시킨 일의 결과라 급한 알림 — 조용한 시간에도 감):
  `kind:"dev.job"` — 개발 작업이 끝남(브랜치·테스트 결과, PR은 아직) 또는 못 끝냄.
  `kind:"browser.task"` — 브라우저 심부름 결과. 직접 하실 단계에서 멈췄으면 안내문이 붙고, 앱 화면이 있으면 §22와 같은 `live` 필드
  (`{"view":"browser-live","reason":…,"url":…}`)가 알림에 실려 온다. 앱은 비서 답의 `live`와 똑같이 '브라우저 화면 열기' 버튼을 보여 주면 된다.
  `kind:"errands.task"` — 생활 심부름 결과(§25의 안내문·`live` 그대로).
  `kind:"work.interrupted"` — 서버가 다시 켜지면서 하던 일이 중간에 멈춤. 일 하나에 한 번만 온다. 개발 작업은 "이어서 해 줘"라고 하면
  같은 작업 공간(없으면 같은 브랜치)에서 다시 한다(`dev.resume`).
- 브라우저 심부름과 생활 심부름은 한 브라우저를 같이 쓰므로 한 줄로 차례대로 돈다. 개발 작업도 한 번에 하나씩.
- 채팅에서 "어떻게 됐어?"·"뭐 하고 있어?"는 도구 `work.status`가 답한다.

### 28.1 `GET views/work` (읽기 전용, `skill.work` — 기본 켜짐)
```json
{
  "title": "하고 있는 일",
  "message": "지금 하고 있는 일 1개\n· owner/repo: 파서 고치기: 하는 중 — 테스트 중 (12분째)\n최근에 끝난 일\n· 가격 알아보기: 끝남",
  "active": [
    { "id": "dev:job_1a2b3c4d", "kind": "dev", "title": "owner/repo: 파서 고치기", "status": "running", "phase": "테스트 중",
      "startedAt": "2026-11-23T00:00:00.000Z", "updatedAt": "2026-11-23T00:11:30.000Z", "elapsedMinutes": 12,
      "origin": { "channelId": "channel.app", "address": "owner" } }
  ],
  "recent": [
    { "id": "browser_9f8e7d6c", "kind": "browser", "title": "가격 알아보기", "status": "done", "summary": "브라우저 심부름 '가격 알아보기'을(를) 마쳤어요. …",
      "link": "https://example.com/item", "startedAt": "…", "updatedAt": "…", "elapsedMinutes": 40 }
  ]
}
```
- `status`: `queued`(차례 기다림) · `running` · `waiting`(오너가 할 단계에서 멈춤: 로그인·누를 버튼·결제) · `done` · `failed` · `interrupted`.
  `active`는 `queued`·`running`·`waiting`(하루 넘게 손대지 않은 `waiting`은 `recent`로), 최근 시작한 순서. `recent`는 끝난 일 최대 20개, 최근 바뀐 순서.
- `kind`: 지금은 `dev`·`browser`·`errand`. 처음 알아보기·루틴 같은 기능이 나중에 같은 목록에 들어올 수 있으니 모르는 `kind`도 그대로 보여 준다.
- `phase`는 사람이 읽는 말(개발 작업: 준비 중 → 작업 공간 만듦 → 코드 고치는 중 → 테스트 중 → 커밋 중). `summary`·`link`(페이지 주소·브랜치·PR 주소)는 끝난 뒤에만.
- `origin`은 일을 시킨 대화(알 때만). 앱은 목록에서 그 대화로 데려갈 수 있다.
- `summary`에는 페이지에서 읽은 글이 섞일 수 있다 — 글자로만 보여 주고 링크·명령으로 다루지 않는다.

## 29. 사람 (`people`, 2026-11-24)

주인이 대화에서 "김민수 대표님은 ~야"처럼 알려 준 사람을 **인물 카드**로 남긴다. 메일·캘린더에서 만난 같은 사람(이름·주소)과 한 사람으로 합쳐진다. 카드는 메인 대화와 모든 봇 방이 매번 본다("대표님"이 누군지 다시 묻지 않음).

- `GET views/people` → `{title:"사람", people:[{key, name, names[], title?, company?, relation?, note?, emails(개수), lastSeen?, openCommitments(개수), updatedAt}]}` — 카드가 있는 사람만, 최근에 바뀐 순. `title` 직함·역할, `company` 회사, `relation` 주인과의 관계("내가 일하는 회사 대표"), `note` 특징 몇 줄(줄바꿈 `\n`). 이메일 주소 자체는 주지 않는다.
- `POST views/people/edit {key, title?, company?, relation?, note?}` → `{person}` — 주인이 직접 고침. 준 칸만 바뀌고, 빈 문자열은 그 칸을 지움. 한도: 직함 40·회사 60·관계 80·메모 400자(넘으면 400 `message:"메모는 400자까지 쓸 수 있어요."`처럼 어느 칸인지). 없는 사람은 400 `message:"그런 사람이 없어요."`.
- 카드 지우기·사람 합치기는 대화로("김민수 카드 지워 줘").
- 서버가 기능을 알리는 방법: `capabilities.views`에 `people`.

## 30. 받아쓰기 (`dictation`, 2026-11-24)

채팅 입력창의 마이크 버튼. 짧게 말한 것을 이 맥(서버)에서 글로 바꿔 입력창에 넣는다. 보내는 것은 주인이 글을 보고 고친 뒤 직접.

- 서버가 `capabilities.features`에 `dictation`을 알릴 때만 버튼을 보인다. 서버는 받아쓰기가 실제로 돌 수 있을 때만(whisper 모델·whisper-cli·ffmpeg가 있을 때, 또는 API) 알린다.
- 녹음 1초 미만은 보내지 않고 "너무 짧아요". 요청 시간 제한은 세 앱 모두 120초.
- `POST dictation` — 본문은 녹음 바이트 그대로(업로드 경로, 사진·회의 녹음 조각과 같음), `Content-Type: audio/mp4`(AAC, m4a) 또는 `audio/webm`(opus). 12MB까지(대략 몇 분); 긴 이야기는 회의 녹음(`recordings`)으로.
- 응답 `200 {ok:true, text}` — `text`가 빈 문자열이면 말소리를 못 찾은 것이고 `message`가 함께 온다. `400 too_short` · `413 too_long` · `503 no_transcriber` · `500 failed`, 모두 `message`(주인에게 그대로 보여 줄 문장).
- 받아쓰기는 몇 초 걸린다(맥의 whisper.cpp). 그동안 버튼에 진행 표시, 다시 누르면 취소(요청 중단). 녹음 파일은 받아쓴 즉시 지우고 아무것도 남기지 않는다.
- 녹음 권한은 회의 녹음과 같은 마이크 권한(데스크톱 `NSMicrophoneUsageDescription`).

## 31. 작업 패널 (`work`에 하위 작업, 2026-11-24)

비서가 뒤에서 하는 일을 대화 옆(데스크톱: 오른쪽 패널, 휴대폰: 아래쪽 시트)에 실시간으로 보여 준다. 데이터는 §28 `views/work` 그대로이고, 항목이 늘었다.

- 새로 올라오는 것: 봇에게 맡긴 일(`kind:"bot"`, 제목 "봇 이름 · 할 일", 팀이 매일 스스로 찾아 한 일 포함), 'ax 개선'의 하위 작업(`kind:"dev"`, 제목 "하위 작업 · …"), 운영 하위 작업(맡긴 일과 같은 `bot`), 자동 개발(dev 작업).
- 항목의 `parent`(선택): 이 일을 나눠 준 일의 `id`. 패널은 부모 아래에 들여 쓰고, 부모가 끝났어도 하위가 돌면 부모를 열어 둔다.
- `origin.address`가 `bot:<id>`면 그 봇 방, `owner`면 메인 대화로 "열기".
- 패널: 하는 중(`queued`·`running`·`waiting`)을 위에, 최근 끝난 것 3~5개를 아래에. 하는 중인 게 있으면 15초마다 `views/work`를 다시 읽고, 없으면 대화의 새 알림(`notice`)이 올 때 다시 읽는다. 접을 수 있고, 접어도 하는 중 개수는 보인다.

## 32. 앱 업데이트 (`app-updates`, 2026-11-24)

스토어 없이, 비서 맥이 직접 빌드한 안드로이드·맥 앱을 짝지은 앱에 나눠 준다.

- 서버가 `capabilities.features`에 `app-updates`를 알리면, 앱은 켤 때와 하루 한 번 `GET views/app-updates`를 읽는다 → `{ android?: {build, versionName, builtAt, sha256, size}, desktop?: {…같음} }` (그 맥에 빌드가 있을 때만).
- 내 빌드 번호(안드로이드 versionCode, 맥 앱은 빌드 때 박은 번호)보다 `build`가 크면 "새 버전이 있어요 · 바꾸기"를 보여 준다. 주인이 눌러야 바꾼다.
- 파일: `GET app-updates/android.apk`, `GET app-updates/desktop.zip` (기기 토큰 필요, 짝지은 기기만). 받은 뒤 `sha256`을 확인하고 다르면 버린다.
- 안드로이드: 같은 키로 서명돼 있어 기존 앱 위에 깔린다(데이터·연결 그대로). PackageInstaller로 설치, "출처를 알 수 없는 앱" 허용이 처음 한 번 필요.
- 맥 앱: zip을 풀어 `/Applications/ax-kit.app`을 바꾸고 다시 연다(연결 그대로).
- 빌드 번호: 앱 저장소의 커밋 수(`git rev-list --count HEAD`). 안드로이드는 `AXKIT_VERSION_CODE`/`AXKIT_VERSION_NAME`, 서명은 `AXKIT_KEYSTORE`/`AXKIT_KEYSTORE_PASSWORD`/`AXKIT_KEY_ALIAS` 환경 변수로 받는다(`ax-kit phone apk`가 넣어 줌).

## 33. 구글 계정 여러 개 (2026-11-24)

- 서버만 바뀜, 앱 화면 변경 없음. `ax-kit connect google add`로 계정을 더 연결(최대 5개), `accounts`로 목록, `remove <주소>`로 빼기.
- 첫 계정은 기존 비밀값(`google.refresh-token`), 더한 계정은 `google.refresh-token.a2`…`a5`, 목록은 `google.accounts` `{primary, extra:[{key,email}]}`.
- 메일·일정은 모든 계정에서 모아 최신순·시작순으로. 결과에 `account`(주소)가 붙음(계정이 둘 이상일 때만). 더한 계정의 id는 `a2~<원래 id>`라서 읽기·답장·보내기·보관이 그 메일이 있는 계정으로 감.
- 새 메일·새 일정·문서·시트·할 일은 첫 계정으로. 더한 계정의 드라이브는 자기 파일만 별도 출처(`drive:a2`)로 색인.

## 34. 드라이브 화면 (`drive`, 2026-11-24)

- 기능 `drive`(구글 드라이브가 연결돼 있을 때만). `capabilities.views[]`에 `{name:"drive", version:1, ui:"blocks", title:"드라이브", icon:"externaldrive"}`. 앱 변경 없이 §14 블록으로 그려짐.
- `GET views/drive` → `{title:"드라이브", blocks}`: `stat` "최근 30일 동안 바뀐 내 파일", 날짜별 `list`(제목 `오늘 · 3건`), 줄마다 `{title: 파일 이름, detail: "폴더 · 계정", trailing: "14:05", message}`, 끝에 `note`와 `ask` 두 개. 계정이 둘 이상이면 `detail`에 계정 주소. 5분 캐시.
- **새 필드 `rows[].message`**(선택, 모든 blocks 화면에 쓸 수 있음): 그 줄을 누르면 앱이 이 문장을 대화로 보낸다(`ask` 블록과 같은 동작). 없으면 누를 수 없는 줄. 모르는 앱은 무시해도 된다.

## 35. 파일로 지식 문서 고치기 (2026-11-24)

- 서버만 바뀜. 대화 도구 `knowledge.learn_preview {name | source+id}`(읽기: 파일을 읽고 넣을·고칠 줄 목록 제안)와 `knowledge.learn_apply {proposal_id, skip?}`(쓰기, 항상 결재 카드: 카드 본문에 바뀌는 줄과 지금 내용).
- 승인된 줄은 `origin:"file"`, `sources:["Drive: 파일 이름"]`로 지식 문서에 들어감(§5.3 `knowledge` 뷰의 `origin`에 `"file"`이 새로 올 수 있음 — 모르는 값은 "추정"처럼 보여 주면 됨). 처음 알아보기·기억 정리가 다시 돌아도 지워지지 않고, 오너가 고친 줄은 덮지 않음. 지식 화면의 "틀림"으로 고칠 수 있음.
- 드라이브 화면(§34) 줄의 `message`는 "요약하기 / 지식 문서에 반영하기" 중 고르게 묻는 문장으로 바뀜.

## 36. 캘린더 여러 개 (2026-11-25)

- 서버만 바뀜. 일정 읽기는 기본 캘린더만이 아니라 오너가 구글 캘린더에서 체크해 둔 모든 캘린더(숨김·체크 해제 제외, 최대 15개). 일정에 `calendar`(캘린더 이름)가 붙음(캘린더가 둘 이상일 때). 같은 회의가 두 캘린더에 있으면 한 번만.
- 대화 도구 `calendar.calendars`(이름·id·쓸 수 있는지·설명), `calendar.add_event`에 `calendar`(id 또는 이름): 비서가 이름·설명·비슷한 일정이 있는 곳을 보고 고름, 오너가 말하면 그대로. 없으면 기본 캘린더.
- 권한 `calendar.calendarlist.readonly`가 새로 필요함(연결할 때 요청). 그 전 로그인은 기본 캘린더만 읽히고 `calendar.calendars`가 `limited`를 알림 → 비서 맥에서 `ax-kit connect google`을 한 번 더.
- **일정 화면(R5 `views/calendar`)에 새 필드**(모두 선택, 모르는 앱은 무시해도 됨):
  - `events[].calendar?`(캘린더 이름, 둘 이상일 때)·`events[].account?`(구글 계정이 둘 이상일 때). `views/today` 일정에도 `calendar?`.
  - 응답 맨 위 `calendars?: [{id, name, primary, writable, description?, account?}]` — 범례(캘린더마다 색)와 추가할 때 고르는 목록. `writable:false`(공휴일 등)는 고르는 목록에서 뺄 것. `calendarsLimited?: true`면 "기본 캘린더만 보여요 — 비서 맥에서 `ax-kit connect google`" 안내.
  - `add`에 `calendar?`(`calendars[].id` 권장, 이름도 됨). 없으면 기본 캘린더. 응답 `{id, calendar?}`(들어간 캘린더 이름).
