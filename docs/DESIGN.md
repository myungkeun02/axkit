# ax-kit 설계 (초안 v0.1, 2026-11-02)

> ax-kit(가칭)은 원본 개인 AX(`~/projects/ax-hq`)에서 검증된 비서 하네스를 **다른 사람이 자기 컴퓨터에 설치해 쓰는**
> 제품으로 다시 만든 것이다. 원본 AX는 그대로 두고, ax-kit은 별도 저장소·별도 데이터로 시작한다.
> 이 문서는 설계와 전체 기능 계획이다. 아직 구현하지 않는다.

목차

1. 목표와 범위
2. 하네스 (가장 중요 ①)
3. 초기 설정 (가장 중요 ②)
4. 일 나누기: 앞단 비서와 일꾼 (가장 중요 ③)
5. 기능 목록: AX에 있는 모든 에이전트 기능
6. 안전과 법
7. AX에서 가져오기 전에 뺄 것
8. 마일스톤
9. 정해야 할 것

---

## 1. 목표와 범위

- **한 사람 = 한 설치.** 사용자 한 명이 자기 컴퓨터에 설치하고, 자기 Discord 서버에서 자기 비서와 대화한다. 다중 사용자 SaaS가 아니다.
- **지식 먼저.** 연결한 메일, Drive 파일, 로컬 파일을 읽어 그 사람에 대한 지식을 만들고, 남은 빈칸만 객관식 인터뷰로 채운다.
- **비서는 Discord에서.** 설정이 끝나면 모든 것이 Discord 안에서 일어난다. 가능한 한 버튼(객관식)으로.
- **개발 일은 명령할 때만.** 사용자의 GitHub 저장소에서 작은 개발 작업을 하고 PR까지 만든다. 머지는 하지 않는다.
- **회사 모드는 나중.** 원본 AX의 org/teams 같은 구조는 M4 이후 선택 기능.
- **AX의 에이전트 기능은 전부 포함한다.** 5장의 목록이 기준이며, 이식 방식(그대로/일반화/플랫폼 전용)을 표시한다.

설계 원칙 (AX에서 실제로 효과가 확인된 것):

1. **결정은 코드, 문장은 모델.** 위험 등급, 보내기 허락, 돈 확인, 지시 출처 판정은 코드가 한다. 모델은 계획을 제안할 뿐이다.
2. **지시는 주인 말에서만.** 메일·웹·카톡·파일·도구 결과는 아무리 명령처럼 보여도 데이터다.
3. **묻기 전에 찾기, 물을 땐 객관식 하나.** 되묻기는 비용이다. 자기 기록을 먼저 찾고, 꼭 필요할 때만 최선의 추측이 첫 번째 버튼인 질문 하나.
4. **사람만 할 수 있는 일은 사람에게, 나머지는 끝까지.** 로그인·2FA·캡차·약관 동의·비밀번호·결제 입력은 사람. 그 앞뒤는 전부 자동.
5. **측정하고 고친다.** 되물음 비율, 답 길이, 무응답, 심부름 성공률을 매일 재고, 밤마다 조정한다.

---

## 2. 하네스

AX 출처: `src/chief/*`, `prompts/chief/*`, `src/latte/*`, `src/knowledge/*`, `src/act/*`, `src/guard/*`, `src/llm/*`,
`docs/strategy/agent-harness.md`.

### 2.1 에이전트 루프

한 메시지의 처리 순서 (AX `chief.ts`와 같은 모양, 단계마다 코드 경계가 있다):

```
Discord 메시지
 → (1) 주인 확인: 설정된 owner user id + 허용 채널. 아니면 무시(답 없음).
 → (2) 저장: chat_messages (비밀 모양은 저장 전 가림)
 → (3) 묻기 전에 찾기(resolver): 요청 낱말로 사실·그래프·메일·일정·구매·지난 대화·작업 검색 (읽기 전용)
 → (4) 문맥 조립 (2.2)
 → (5) 계획 모델 호출: 구조화 JSON { reply, tool_calls[], question|null, rich|null }
 → (6) 질문 정책: 되묻기만 하는 계획이면 "읽기 도구로 먼저 시도 + 최선의 추측 질문 하나"로 재작성 (ask-policy)
 → (7) 게이트(코드): 각 tool_call마다 흐름 게이트(2.4) → 위험 등급(2.5) → 인자 검증(manifest JSON Schema)
 → (8) 실행:
        R0/R1 → 바로 실행
        R2/R3 → 확인 카드 (정확한 내용, 1회용, 만료)
        오래 걸리는 도구 → 작업 큐로 (4장), 상태 카드 + 스레드
 → (9) 답 도구(읽기 결과를 말로 바꿔야 하는 도구)가 있으면 2차 호출로 한 번 더 정리
 → (10) 출력: 한 말풍선 또는 여러 말풍선 + 다음 행동 버튼 (2.6)
 → (11) 감사 기록: 계획, 게이트 판정, 도구 결과, 모델 호출(토큰·비용·지연·민감도)
```

부가 루프:

- **놓친 말 다시 잡기(heartbeat).** 5분마다 5분~6시간 동안 답이 없는 주인 메시지를 찾아 한 번만 다시 처리한다. 두 번째도 빈 계획이면 침묵 대신 솔직한 한 줄. (AX `latte/open-loops.ts`)
- **먼저 말하기.** 메일·일정·작업 결과를 짧은 한 줄로 먼저 알린다. 같은 일 두 번 금지, 조용한 시간(사용자 설정), 시간당 상한, 주인이 3분 안에 말했으면 급하지 않은 줄은 기다림. (AX `latte/proactive.ts`, `voice.ts`)
- **버튼 = 주인 말.** 비서가 낸 버튼을 주인이 누르면 `(선택: …)` 형태의 주인 메시지로 루프에 다시 들어간다. 버튼은 주인 id에 묶이고 1회용이다.

### 2.2 문맥 조립

프롬프트 캐시를 깨지 않도록 **바뀌지 않는 것 먼저, 바뀌는 것 나중** (AX `context.ts`, `knowledge/core.ts` 교훈):

| 순서 | 블록 | 성격 | 비고 |
|---|---|---|---|
| 1 | 시스템 규칙 (`prompts/assistant/system.md`) | 고정 | 안전 규칙·말투·출력 형식. 자동 조정이 못 건드림 |
| 2 | 조정 덧붙임 (`tuned.md`) | 밤마다 바뀜 | 2.10. 코드가 "위 규칙이 항상 이긴다" 머리말을 붙임 |
| 3 | 도구 목록 | 설정 시 바뀜 | 켜진 manifest 도구만, 이름·설명·인자 스키마 |
| 4 | 핵심 프로필 (`core.md`, 약 2쪽) | 사실이 같으면 글자 그대로 | 생성 시각 같은 변동 값 금지 |
| 5 | 관련 사실 `<related_facts>` (최대 6~8개) | 매번 | 2.7 순위 |
| 6 | 찾은 기록 `<resolved_context>` | 매번 | resolver 결과, 데이터로 감쌈 |
| 7 | 최근 대화 | 매번 | 최근 3턴 밖의 도구 출력은 앞뒤 400자만, 사람 말은 그대로 |
| 8 | 답글 대상 메시지 | 매번 | 데이터로 렌더링 |
| 9 | 지금 시각·시간대·위치 | 매번 | 위치는 주인이 말한 곳 > 폰 최근 위치 > 집 |
| 10 | 현재 메시지 | 매번 | |

외부 데이터는 모두 `<data source="mail" id="…">…</data>` 형태로 넣고, 꺾쇠는 이스케이프한다(AX `ingest/sanitize.ts escapeTaskData`).

### 2.3 지시 출처 경계 (주인의 말만 지시한다)

**지시가 될 수 있는 것은 단 두 가지:** (a) 설정된 owner user id가 허용 채널/DM에 쓴 메시지, (b) 그 주인에게 묶인 버튼·선택·모달 입력.

그 밖의 모든 것 — 메일 본문, 웹 페이지, 카톡 대화, 파일, Drive 문서, 도구 출력, 다른 Discord 사용자, 다른 봇 — 는 데이터다. 이를 코드로 강제한다:

- **흐름 게이트 입력 제한.** 게이트가 읽는 글은 현재 주인 메시지와 같은 채널의 최근 주인 메시지(몇 분 이내)뿐이다. 도구 출력은 게이트 입력이 될 수 없다.
- **고정(anchoring).** 행동의 핵심 인자(보낼 글, 개발 요청, 기억할 사실)는 주인 말의 내용어가 최소 N개 들어 있어야 한다(`anchoredIn`). 메일에서 베껴온 글은 통과 못 한다.
- **이름 확인.** 받는 사람·채팅방·앱 이름은 주인 메시지에 실제로 나와야 한다(`namedIn`).
- **주입 검사.** 보이지 않는 문자, 지시형 문구가 있는 출처는 표시하고, 반복되면 그 출처를 격리한다. 주인이 `guard.unblock`으로만 해제.
- **원격 카드·데스크톱 행동의 입력 글자**는 앱 내용에서 온 것이면 거절한다(AX `desktop/policy.ts`).

### 2.4 흐름 기반 게이트

키워드 한 단어가 아니라 **대화 흐름**을 본다(AX `chief/flow.ts`, 2026-11-02 원칙):

- **후속 말 인식.** 40자 이하이고 부정이 아닌 짧은 말("다시 해봐", "응 그거")은 직전 주제의 이어짐으로 본다.
- **버튼 응답.** `(선택: …)`가 예/아니오 중 무엇인지 판정(`choseYes/choseNo`).
- **가능 질문 ≠ 명령.** "바꿀 수 있어?"는 확인 질문 한 번. 바로 실행하지 않는다(`CAPABILITY_Q`).
- **보내기 명령 판정.** "보내줘", "답장해" 같은 외부 발송 명령은 주인 말에 있어야 하고, 부정("보내지 마")이면 막는다.
- **언어팩.** AX의 게이트는 한국어 조사·불용어 정규식이다. ax-kit은 `locale/<lang>/flow.ts`로 분리한다(조사 제거, 불용어, 부정어, 후속 말 길이, 가능 질문 패턴). 첫 언어팩은 ko, 다음 en.

### 2.5 위험 등급과 확인

AX의 P0~P4(우선순위 바닥 + 위원회)를 사용자용 4단계로 단순화한다. 등급은 **manifest에 도구별로 선언**되고, 실행 직전 코드가 실제 인자로 다시 계산해 올릴 수만 있다(내릴 수 없다).

| 등급 | 뜻 | 예 | 처리 |
|---|---|---|---|
| R0 | 읽기 | 메일 검색, 일정 보기, 가격 조회, 카톡 읽기 | 바로 실행 |
| R1 | 내 공간 안, 되돌릴 수 있음 | 기억, 리마인더, 메일 초안, 가격 지켜보기, 내 저장소 브랜치·PR | 바로 실행 + 기록. 자동 실행 사후 보고 줄 + [잘못됨] 버튼 → 그 종류는 이후 카드로 |
| R2 | 내 이름으로 밖에 나감 | 메일 보내기, 카톡 보내기, 참석자 있는 일정 초대, 게시, 데스크톱 앱의 보내기 버튼 | **확인 카드**: 받는 사람·정확한 본문·시각 그대로. 1회용, 10분 만료, 누른 뒤 그대로 실행 |
| R3 | 돈·되돌릴 수 없음·보안 | 결제, 선결제 예약, 해지·탈퇴·삭제, 계정·권한 변경 | **확인 카드 + 재확인**(Discord 모달의 확인 문구 또는 설정한 PIN) + 금액 한도. 실제 결제 입력은 사람이 원격 카드에서 |

규칙:

- **카드에 보인 것 = 실행하는 것.** 카드 생성 시 인자 해시를 저장하고 실행 직전 비교한다(AX `act/card.ts`, `act/code-only.ts`).
- **실행 직전 재검사.** 금액·받는 사람·첨부를 실제 값으로 다시 계산해 등급을 올린다(AX `act/facts.ts`, `floor.ts`).
- **전체 정지.** `/정지`(`/stop`)는 DB 플래그 하나. 모든 R2/R3 경로가 실행 직전 확인한다(AX `guard/kill.ts`).
- **결재 카드 형식.** 세 줄: 무엇을 정하는지 / 왜 / 누르면 무슨 일이 생기는지. 자세한 건 「자세히」 스레드(AX `discord/owner-card.ts`).
- **돈 자동 결제 한도의 기본값은 0원**(= 항상 카드). 사용자가 원하면 설정에서 올린다. AX의 10만 원 자동 결제는 원본 사용자 개인 결정이므로 가져오지 않는다.

### 2.6 여러 말풍선과 객관식 출력

계획 JSON의 `rich` (AX `chief/rich.ts`):

```
ack?        "현실적으로 계산해 볼게요"  (한 줄)
conclusion  결론 먼저, 핵심 숫자 굵게
sections[]  짧은 섹션 1~3개
card?       timeline | comparison | checklist 임베드
question?   목표가 분명한 질문 하나
next[]      다음 행동 버튼 2~4개 (누르면 주인 말로 들어감)
```

- 인사·잡담·단순 사실·짧은 부탁은 **한 말풍선, rich 없음**. 분석·계획·비교·조사만 rich.
- 질문은 **한 번에 하나, 객관식**: 첫 버튼 = 비서의 최선의 추측, 마지막 = "다른 거예요"(모달로 직접 입력).
- Discord 제약: 메시지당 버튼 줄 5개·줄당 5개, 임베드 6000자. 표는 Discord가 그리지 않으므로 임베드 필드나 목록으로 바꾼다(AX `discord/format.ts`).
- 모든 필드는 "필수지만 null 허용"으로 정의해 OpenAI strict 구조화 출력과 Anthropic 도구 스키마 양쪽에서 쓴다.

### 2.7 자동 기억: 출처와 감쇠

AX `knowledge/*`, `assist/memory.ts`, `latte/facts.ts`, `latte/attachments.ts` 기반.

**사실(fact) 한 줄의 모양:**

| 필드 | 값 |
|---|---|
| text | "우유는 오트밀크를 산다" |
| category | identity / work / people / place / preference / routine / commerce / health / finance / rule / other |
| provenance | `owner_stated`(주인 말) · `owner_action`(주인 행동: 버튼, 결정) · `owner_authored`(주인이 쓴 메일·문서) · `third_party`(받은 메일, 다른 사람) · `agent_inferred`(비서 추론) |
| scope | `standing`(계속) · `one_off`(이번 한 번 — 저장 안 함) |
| confidence | 0~1 |
| evidence | 출처 참조 목록(메시지 id, 메일 id, 파일 경로+해시) |
| observed_at / last_seen_at / expires_at | 시간 |
| supersedes | 대체한 사실 id |

**쓰기 규칙** (AX `librarian.ts applyFactRules`):

- 일회성 요청은 저장하지 않는다.
- 주인 말 근거가 없으면 추론으로 강등(confidence ≤ 0.5).
- 선호는 주인 말 또는 독립 근거 2개가 있어야 standing.
- 상대 날짜("다음 주")는 말한 날 기준 절대 날짜로 고정.
- 비밀·카드번호·신분번호는 저장 전 가린다(언어팩별 패턴).

**충돌 해결** (AX `reconcile.ts`, mem0 방식): 같은 말이면 "다시 봄"만 표시. 비슷한 사실 5개와 비교해 민감 등급 모델이 add / update(대체) / duplicate 결정. 모델은 보여준 후보만 대체 가능, 새 숫자 금지, 실패하면 단순 추가.

**감쇠와 검색 순위** (AX `store.ts rankedFacts`): 요청 낱말 일치 수 + 30일 반감기 감쇠(`owner_stated`·첨부·인터뷰 답은 감쇠 없음) + 확인·관찰 가점 → MMR(λ 0.7)로 비슷한 것 중복 제거 → 상위 6~8개. 사실이 1,000개를 넘으면 로컬 임베딩(sqlite-vec) 점수를 합친다. 추론 사실은 90일 동안 다시 관찰되지 않으면 `expired`.

**대화 자동 기억.** "기억해" 없이도 대화에서 주인이 말한 사실을 하루 몇 번 묶어서 추출한다. **주간 검토 카드**: 새로 추론한 사실 중 영향 큰 것만 ✅/❌ 버튼으로(한 메시지 최대 5개).

**절차 기억.** 웹에서 찾은 일 처리 절차(예: 증명서 발급)를 일반 단계로만 저장, 같은 요청이면 90일 재사용, 실패하면 폐기.

**지식 그래프.** 사실에서 (사람/장소/조직/물건) 관계를 고정 어휘로만 뽑아 그래프로 유지, "지식 그래프 보여줘"에 PNG로 답한다. 사실이 원본, 그래프는 언제든 재생성.

### 2.8 모델 라우팅

**사용자가 가진 것을 쓴다.** 설정 때 버튼으로 고른다:

| 공급자 | 연결 방식 | 비고 |
|---|---|---|
| Anthropic API | API 키(키체인) | 기본 권장 |
| OpenAI API | API 키 | |
| Claude 구독 | 사용자 컴퓨터의 Claude Code CLI(`claude -p`) / Agent SDK | **약관 확인 필요**(9장). 사용자가 자기 컴퓨터에서 자기 일로 쓰는 경우에 한함 |
| ChatGPT 구독 | Codex CLI(`codex exec`) | 같은 주의 |
| 기타 API (DeepSeek, OpenRouter 등) | API 키 | 기본은 "공개/가린 데이터만" |
| 로컬 모델 (Ollama, LM Studio) | localhost | 민감 데이터 전용으로 쓸 수 있음 |

**등급(tier)**: `fast`(분류·요약), `standard`(비서 계획·답), `deep`(인터뷰 가설·개발 검증). 단계별 추론 강도를 따로 둔다(AX `stage_effort`).

**민감도 라우팅** (AX `llm/sensitivity.ts`, `policy/models.yaml allowed_sensitivity`):

- `sensitive` = 원본 개인 데이터(메일 본문, 카톡, 파일, 위치, 지출, 첨부 이미지)
- `masked` = 이메일·전화·번호를 가린 것
- `public` = 공개 정보(웹 조사 등)

각 공급자에 허용 민감도를 붙인다. 기본값: 사용자가 처음 고른 주 공급자(Anthropic 또는 OpenAI) + 로컬 모델만 `sensitive`. 나머지는 `masked/public`. 가림 여부는 코드가 만든 불투명 타입으로만 증명된다(문자열 조작으로 위조 불가).

**안정성**: 공급자별 차단기(연속 실패 3회 → 5분 열림, 반 열림 실패마다 2배, 최대 30분), 일·월 비용 상한, 상한 도달 시 다음 후보. 구독 CLI는 5시간·주간 사용량을 읽어 여유가 많은 계정에 더 나눈다(AX `llm/router.ts`, 사용자 계정이 여럿일 때만).

### 2.9 도구·연결기 manifest

다른 사람이 연결기를 추가할 수 있도록 **모든 도구는 manifest로 선언**한다. 스키마: `schemas/tool-manifest.schema.json`.

```yaml
id: gmail                     # 연결기 id
version: 0.1.0
title: { ko: Gmail, en: Gmail }
platforms: [macos, linux, windows]
locales: ["*"]
auth:
  kind: google_oauth          # none | keychain_secret | google_oauth | oauth2 | cli_login | os_permission
  scopes: [https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/gmail.compose]
secrets: [google-oauth-client, google-refresh-token]
setup:                        # Claude Code 설정 에이전트가 따라 하는 단계
  - { id: consent, kind: human, say: { ko: "구글 로그인과 권한 허용은 직접 눌러 주세요" } }
ingest:
  - { id: mail, schedule: "*/5 * * * *", cursor: history_id, sensitivity: sensitive }
tools:
  - name: mail.search
    description: { ko: "주인 메일 검색", en: "Search the owner's mail" }
    args: { $ref: "#/defs/mailSearch" }
    risk: R0
    output_sensitivity: sensitive
    answer_tool: true         # 결과를 비서가 말로 다시 정리
    worker: inline            # inline | mail | calendar | research | browser | desktop | kakao | commerce | dev
    timeout_s: 30
  - name: mail.send_reply
    risk: R2
    gates: { anchored_args: [body], named_args: [], send_order: true }
    worker: mail
    concurrency_key: mail-send
```

규칙:

- 모델에는 **켜진 연결기의 도구만** 보인다. 꺼진 도구 이름은 프롬프트에 없다.
- `risk`는 하한이다. 실행 직전 코드가 올릴 수만 있다.
- `gates`는 흐름 게이트(2.4)를 선언으로 붙인다: `anchored_args`, `named_args`(받는 사람·방 이름이 주인 말에 있어야 함), `send_order`(보내기 명령 필요), `capability_question_blocks`.
- 연결기 코드는 `connectors/<id>/index.ts`에서 `defineConnector()`로 등록. 제3자 연결기는 같은 폴더 구조의 npm 패키지(`axkit-connector-*`)로 설치한다. **제3자 연결기는 기본 R2 이상 도구를 켤 수 없고, 사용자가 연결기별로 허락**해야 한다.
- 연결기는 비밀을 직접 읽지 않고 `ctx.secrets.get(name)`으로만 받는다(manifest에 선언한 이름만).

### 2.10 밤마다 자기 조정

AX `latte/autoresearch.ts` 방식(Karpathy autoresearch):

- **고칠 수 있는 곳은 `tuned.md` 하나.** 시스템 규칙·안전 규칙·게이트·코드는 절대 못 고친다.
- **평가 세트**: 주인의 실제 대화에서 매일 수집(로컬 DB에만), 학습/검증 한 번 나눔.
- **채점 기준**: `program.md`(사용자가 고칠 수 있음). 항목: 흐름·쉬운 말·말풍선·도구·안전. 안전 위반은 그 사례 0점.
- **루프**: 학습 세트 실패에서 작은 수정 하나 제안 → 검증 세트를 실제 계획 프롬프트로 건식 실행(도구는 제안만) → 다른 모델이 채점(프롬프트는 안 봄) → 최고 점수를 넘으면 채택, 아니면 버림. 하룻밤 예산(호출 수·비용) 고정.
- **보고**: 채택될 때만 아침에 한 줄.
- 같은 밤에 **기억 감쇠·만료**, **품질 지표 스냅샷**(되물음 비율, 답 길이 p50/p90, 무응답, 심부름 성공률, 계획 토큰)도 돈다.
- 공개 하네스 릴리스 감시(AX `harness/watch.ts`)는 선택 기능, 기본 꺼짐.

### 2.11 관찰 가능성

- **감사 기록(audit)**: 모든 게이트 판정, 도구 호출, 카드 생성·누름·만료, 정지/재개. 삭제 불가 테이블(트리거로 UPDATE/DELETE 거부).
- **모델 호출 기록(llm_calls)**: 공급자·모델·등급·민감도·토큰·비용·지연·성공/실패·작업 id.
- **작업 기록(jobs, job_events)**: 4장.
- **Discord 명령**: `/상태`(켜진 연결기·작업·오류), `/사용량`(공급자별 비용·한도), `/정지` `/재개`, `/기억`(검색·삭제), `/도움말`.
- **`axkit doctor`**: 키체인 항목(이름만 확인), 권한(손쉬운 사용·화면 기록), 연결기 토큰 유효성, DB 무결성, 데몬 상태.
- **로그 가림**: 로그에 비밀·토큰 모양은 쓰기 전 가린다(AX `log-sanitize.ts`).
- **외부 텔레메트리 없음**(기본). 오류 보고는 사용자가 버튼으로 골라 보낼 때만.

---

## 3. 초기 설정

### 3.1 설치 명령

설정은 **사용자 컴퓨터의 Claude Code가 한다.** 사람은 로그인·2FA·캡차·약관 동의·토큰 복사만 한다.

```bash
# 1) 받기 (저장소 공개 방식은 결정 후)
git clone <repo> ax-kit && cd ax-kit

# 2) Claude Code로 설정 시작 — 저장소의 .claude/skills/axkit-setup 을 따라감
claude "/axkit-setup"
```

설정 에이전트가 하는 일 (`setup/SETUP_AGENT.md`가 순서와 사람 확인 지점을 정의):

1. 사전 점검: OS, Node 22+, pnpm, git, (선택) gh, Chrome. 없으면 설치 명령을 보여주고 사용자 확인 후 실행.
2. `pnpm install`, `pnpm axkit init` → `~/.axkit/`(권한 700) 생성, DB 만들기, 키체인 서비스 이름 `axkit` 준비.
3. 모델 공급자 고르기(터미널 선택지) → 키 입력은 **사용자가 직접** `pnpm axkit secret set anthropic-api-key`(숨김 입력)로.
4. Discord 봇 만들기(3.4).
5. 데몬 시작(launchd / systemd user / 작업 스케줄러) → 봇이 사용자 서버에 첫 메시지.
6. **여기서부터는 Discord에서**: 연결기 고르기(버튼), Google 연결(3.5), 로컬 폴더 고르기, 수집 시작, 인터뷰.

### 3.2 로컬 DB: SQLite (Postgres+pgvector는 선택)

**결정: 기본 SQLite**(WAL 모드, FTS5 전문 검색, 선택 확장 sqlite-vec). 저장소 계층은 어댑터로 두어 회사 모드에서 Postgres+pgvector를 쓸 수 있게 한다.

| 기준 | SQLite | Postgres + pgvector |
|---|---|---|
| 설치 | 없음(파일 하나) | Docker/OrbStack/Homebrew 서비스 필요 |
| 장애 | 프로세스 안에서 돌아 별도 서버 다운 없음 | AX 사고 INC-1(2026-10-21): OrbStack이 죽어 DB 17분 중단, 워치독까지 만들어야 했음 |
| 규모 | 1인: 메일 5만 통, 파일 수천 개, 사실 수천 개 — 충분 | 과함 |
| 동시성 | 쓰기 1개(데몬 하나가 씀), 읽기 여럿 — 1인 비서에 맞음 | 여러 프로세스·팀 동시 쓰기에 유리 |
| 검색 | FTS5(낱말) + sqlite-vec(선택) | tsvector + pgvector |
| 백업·암호화 | 파일 복사, SQLCipher 선택 | pg_dump, 디스크 암호화 |
| 이식성 | macOS/Linux/Windows 동일 | OS별 설치 차이 |

AX의 기억 검색은 이미 낱말+감쇠+MMR이고 벡터를 쓰지 않는다(사실 100여 개). 1인 제품에서 Postgres의 이점은 작고 운영 비용(설치 실패, 서버 다운)은 크다. 회사 모드(여러 팀 일꾼이 동시에 쓰는 경우)에서 Postgres 어댑터를 켠다.

**DB 파일 위치**: `~/.axkit/data/axkit.db` (권한 600). 첨부·캡처는 `~/.axkit/files/`.

### 3.3 비밀은 OS 키체인에

- macOS: Keychain (`security` CLI, 비밀은 stdin으로만 — argv에 안 남게. AX `secrets.ts` 방식)
- Linux: Secret Service(libsecret, `secret-tool`)
- Windows: Credential Manager
- 서비스 이름 `axkit`, 계정 = 비밀 이름(`discord-bot-token`, `anthropic-api-key`, `google-oauth-client`, `google-refresh-token:<email>`, `github-token:<owner>/<repo>`, `phone-hook-token` …).
- 설정 파일(`~/.axkit/config.json`)과 DB에는 비밀이 들어가지 않는다. 이름만.
- **모델은 비밀을 절대 보지 않는다.** 토큰 복사 단계에서도 사용자가 터미널 숨김 입력이나 클립보드 읽기 명령(`pnpm axkit secret set discord-bot-token --from-clipboard`, 읽은 뒤 클립보드 비움)으로 넣고, Claude Code 대화에는 값이 들어오지 않는다.

### 3.4 Discord 봇 만들기 (computer use + 사람 확인 지점)

Claude Code가 브라우저(Claude in Chrome 또는 computer use)로 Discord 개발자 포털을 조작한다. **사람 몫은 굵게.**

| # | 단계 | 누가 | 확인 |
|---|---|---|---|
| 1 | 비서용 개인 Discord 서버가 있는지 물음(터미널 선택지: 있음/새로 만들기) | Claude | |
| 2 | discord.com 열기 → **로그인, 2FA, 캡차** | **사람** | 로그인된 화면을 Claude가 스크린샷으로 확인 |
| 3 | (새 서버면) 서버 만들기 → 이름 "내 비서" 등 | Claude 조작, 사람 확인 | |
| 4 | discord.com/developers/applications → New Application → 이름 입력 | Claude | |
| 5 | **개발자 약관(Developer ToS·Policy) 동의 체크** | **사람** | AI가 약관에 동의하지 않는다 |
| 6 | Create 누름, 아이콘(선택) 업로드 | Claude | |
| 7 | Bot 탭 → Privileged Gateway Intents에서 **Message Content Intent** 켜기, Public Bot 끄기 | Claude | 저장 후 화면 확인 |
| 8 | Reset Token → **(2FA 다시 요구 시) 사람 입력** → 토큰 표시 | Claude + **사람** | |
| 9 | **토큰 복사 → 터미널에서 `axkit secret set discord-bot-token --from-clipboard`** | **사람** | Claude는 토큰을 읽지도, 스크린샷에 남기지도 않음(그 단계 스크린샷 금지) |
| 10 | OAuth2 → URL Generator: scope `bot` `applications.commands`, 권한(메시지 보내기, 스레드 만들기·보내기, 임베드, 파일 첨부, 반응, 메시지 기록 읽기) → URL 생성 | Claude | |
| 11 | URL 열기 → 서버 선택 → **승인(캡차 나오면 사람)** | Claude + **사람** | |
| 12 | `axkit discord verify` → 봇 접속, 서버·채널 생성(`#비서`, `#결재`, `#작업`, `#기록`), 주인 user id 확인(주인이 `#비서`에 "안녕" → 봇이 버튼으로 "이 분이 주인인가요?") | Claude | |

원칙:

- 각 사람 단계에서 Claude는 **멈추고 기다린다**(터미널에 "로그인 끝나면 엔터"). 사람 몫을 대신 시도하지 않는다.
- 화면이 예상과 다르면(포털 UI 변경) 수동 안내서(`docs/guides/discord-bot-manual.md`, 스크린샷 포함)로 전환한다. **자동화 실패가 설정 실패가 되지 않게.**
- 봇 하나로 시작. 회사 모드의 페르소나 봇은 같은 흐름을 반복한다.

### 3.5 연결기와 Google OAuth

**사용자마다 자기 Google Cloud 프로젝트의 OAuth 클라이언트를 쓴다.**

왜: `gmail.readonly`(메일 읽기)와 `drive.readonly`(Drive 전체 읽기)는 Google의 **restricted scope**다. ax-kit이 **공용 OAuth 클라이언트 하나**를 만들어 모든 사용자가 쓰게 하면:

- Google OAuth 앱 검증(브랜드·개인정보처리방침·데모 영상) +
- **CASA**(Cloud Application Security Assessment, 제3자 보안 평가, Tier 2 이상, 매년 재평가, 비용 발생) 를 통과해야 한다.
- 통과 전에는 사용자 100명 상한, "확인되지 않은 앱" 경고, 그리고 검증 안 된 restricted scope 앱은 일반 사용자에게 막힐 수 있다.
- 또 공용 클라이언트면 ax-kit 운영자가 Google API Services User Data Policy의 "Limited Use" 의무 주체가 된다.

각자 자기 프로젝트의 클라이언트를 쓰면 **"개인 용도" 앱**이 되어 검증·CASA 대상이 아니다(사용자 = 앱 소유자 본인). 주의점:

- **게시 상태 "테스트"의 외부 앱은 refresh token이 7일 뒤 만료된다.** 그래서 OAuth 동의 화면을 "프로덕션"으로 게시하되 검증 신청은 하지 않는다(사용자 본인만 쓰므로 "확인되지 않은 앱" 경고를 본인이 한 번 넘김). Workspace 계정이면 "내부(Internal)"로 만들어 경고 없음.
- 클라이언트 종류는 **데스크톱 앱**(루프백 리디렉트 + PKCE).

Claude Code가 하는 일(computer use, 사람 확인 지점 굵게):

1. console.cloud.google.com → **Google 로그인·2FA** → 새 프로젝트 `axkit-<random>` (**처음이면 Cloud 약관 동의는 사람**)
2. Gmail API, Google Drive API, Google Calendar API 사용 설정(gcloud CLI가 있으면 `gcloud services enable`)
3. OAuth 동의 화면: 외부/내부, 앱 이름, 사용자 이메일, 범위 추가
4. 사용자 인증 정보 → OAuth 클라이언트 ID → 데스크톱 앱 → JSON 다운로드 → `axkit secret import google-oauth-client <파일>` → 파일 삭제
5. Discord에서 [Google 연결] 버튼 → 로컬 루프백 주소로 동의 시작 → **사람이 계정 고르고 "확인되지 않은 앱" 넘기고 권한 허용**

범위(최소 권한, 단계적으로):

| 기능 | 범위 | 등급 |
|---|---|---|
| 메일 읽기 | `gmail.readonly` | restricted |
| 메일 초안 | `gmail.compose` | restricted(발송은 이 범위로 하되 R2 카드 뒤에서만) |
| 일정 | `calendar.events` | sensitive |
| Drive | 기본 `drive.readonly`(restricted). 원하면 `drive.file` + Picker로 고른 파일만(비민감) | |

대안: Gmail은 IMAP + 앱 비밀번호(2단계 인증 필요)도 연결기로 제공(`imap` 연결기). 다른 메일(Outlook 등)은 Microsoft Graph 연결기(나중).

그 밖의 연결기(M1~M3):

| 연결기 | 인증 | 비고 |
|---|---|---|
| local-files | OS 권한(macOS 전체 디스크 접근 불필요, 고른 폴더만) | 3.6 |
| github | 저장소 한정 fine-grained 토큰 | 4.5 |
| slack | 사용자 토큰(읽기) | 선택 |
| browser | 로컬 Chrome 프로필(Playwright/CDP) | 4장 |
| kakao (macOS) | 손쉬운 사용 권한 + kmsg | 선택, 6장 약관 |
| desktop (macOS) | 손쉬운 사용·화면 기록 권한 | 선택 |
| apple (macOS) | 미리 알림 권한 | 선택 |
| phone-hook | 키체인 토큰 + (선택) 터널 | iPhone 단축어 |
| locale-ko | 카카오·네이버·스윗트래커·서울 지하철 API 키 | 한국 생활 정보 |

### 3.6 수집 파이프라인과 예산

```
연결기 → 원본 이벤트(events: source, account, external_id, 메타, 본문 요약) → 정리(마스킹, 서명·인용 제거, 뉴스레터 걸러내기)
      → 조각(chunks, FTS5 색인) → 추출(3.7) → 사실 후보 → 가설(3.8) → 사실
```

**기본 예산** (설정 첫 화면에서 버튼으로 바꿀 수 있음, 시작 전 예상 비용·시간을 보여주고 [시작] 버튼):

| 출처 | 범위 | 상한 |
|---|---|---|
| 메일 | 메타데이터 12개월, 본문은 최근 90일 + **보낸 메일 전체 12개월** | 2만 통, 통당 본문 8KB |
| Drive | 내가 소유했거나 최근 24개월 안에 수정한 문서·시트·PDF | 2,000개, 파일당 텍스트 200KB |
| 로컬 파일 | 사용자가 고른 폴더만(기본 제안: 문서, 데스크톱, 다운로드 중 선택) | 5,000개, 텍스트·PDF·문서만 |
| 일정 | 지난 6개월 + 앞으로 3개월 | 전부 |
| 모델 | 첫 지식 만들기 전체 | 기본 입력 300만 토큰·비용 상한(사용자 통화로 표시), fast 등급 |

거르기 규칙:

- `List-Unsubscribe`·대량 발송 헤더 메일은 본문 추출 제외(영수증·배송·청구 패턴은 예외로 살림).
- 로컬·Drive에서 비밀 파일 제외: `.env`, `*.pem`, `id_*`, 키체인·비밀번호 관리자 내보내기, `node_modules`, `.git`, 1MB 넘는 바이너리.
- **보낸 메일과 주인이 쓴 문서가 가장 값지다**(주인의 말 = `owner_authored`). 우선 처리.
- 증분: 메일은 historyId, Drive는 changes 토큰, 로컬은 mtime+해시. 첫 수집 뒤에는 5분/30분/1일 주기.
- 모든 원본은 로컬 DB에만. 모델에는 조각 단위로, 민감도 라우팅(2.8)을 거쳐 보낸다.

### 3.7 엔티티·선호 추출

두 단계:

1. **결정적 추출(모델 없음, 싸고 정확):**
   - 사람: 보낸·받은 메일의 상대, 빈도·최근성·양방향 여부, 서명 블록(직함·회사·전화), 일정 참석자.
   - 나: 보낸 메일 서명, 계정 이름, 도메인(회사 메일), 시간대(보낸 시각 분포), 언어.
   - 장소: 배송 주소(주문 메일), 일정 장소 반복, 사진 없음.
   - 거래: 영수증·주문·청구·구독 패턴(상점, 금액, 주기).
   - 일: 반복 일정, 저장소 이름, 문서 제목 군집.
2. **모델 추출(fast 등급, 묶음 단위):** 조각 묶음마다 `{사실 후보, category, provenance, evidence, confidence}` JSON. AX `prompts/knowledge/extract.md` 규칙(일회성 제외, 추론 강등, 선호는 근거 2개) 그대로.

후보는 **슬롯**(3.8)에 붙는다. 같은 슬롯의 후보들은 값별로 묶어 근거를 합친다.

### 3.8 가설 기반 객관식 인터뷰

**목표**: 묻는 수는 최소, 물을 때는 거의 맞힌 보기를 내민다.

**슬롯 스키마**(`src/setup/interview/slots.ts`): 각 슬롯 = { id, 질문 틀, 중요도 w(0~1), 값 종류(하나/여럿/자유), 의존 슬롯 }.

| 묶음 | 슬롯 예 |
|---|---|
| 나 | 부를 이름, 언어, 시간대, 사는 동네(대략), 생일(선택) |
| 일 | 직장, 역할, 진행 중인 프로젝트, 근무 시간 |
| 사람 | 가족, 자주 연락하는 5명과 관계, 상사·동료 |
| 생활 | 자주 쓰는 쇼핑몰, 결제 선호, 식사 취향, 이동 수단 |
| 비서 규칙 | 먼저 말하기 정도, 조용한 시간, 확인받을 일, 말투, 아침 요약 시각 |

**가설과 확신도:**

- 슬롯의 각 후보 값 v에 대해 근거 e마다 가중치 `w(e)`: `owner_authored` 0.6, 일정·주문 등 구조 데이터 0.5, `third_party` 0.3, `agent_inferred` 0.2. 같은 출처 반복은 체감(로그 스케일).
- 지지도: `s(v) = 1 − Π(1 − w(e))` (noisy-OR).
- 충돌 보정: 후보들의 지지도를 정규화해 확률 `p(v)`로, 서로 다른 강한 후보가 있으면 확신도가 내려간다.
- 슬롯 확신도 `c = max p(v)`, 불확실도 `H = 엔트로피(p)`.

**질문 고르기:**

- `c ≥ 0.85` → 묻지 않고 받아들임(추론 사실, 요약 카드에서 한 번에 보여주고 고칠 수 있게).
- `c < 0.85` 슬롯마다 점수 `VOI = 중요도 w × H × 쓰임새(그 슬롯이 켜는 기능 수)`.
- VOI 상위부터, **의존 순서**를 지켜(직장 → 역할) 고른다.
- **상한**: 첫 인터뷰 최대 12문항(4문항 × 3라운드). 라운드마다 답으로 가설을 다시 계산해 다음 4문항을 고른다. 남은 질문은 이후 **하루 최대 1개**, 대화 흐름에 맞을 때만(주인이 바쁘면 안 함). 전체 상한 30문항.
- 증거가 전혀 없는 슬롯은 VOI가 높아도 "직접 입력" 질문이 되므로, 중요도 0.7 이상만 묻는다.

**질문 모양 (Discord):**

```
비서: 회사는 어디로 알고 있으면 될까요?
[A사 (메일 214통·서명)] [B사 (2023년까지)] [둘 다 아니에요] [건너뛰기]
```

- 보기 = 확률 상위 2~3개(근거 요약 짧게), + "다른 거예요"(모달 입력), + "건너뛰기".
- 여러 값 슬롯(가족, 자주 쓰는 쇼핑몰)은 선택 메뉴(최대 25개 중 여러 개).
- 근거 요약에는 **이름·건수·기간만**. 메일 본문은 보여주지 않는다.

**답이 지식을 바꾸는 방식:**

- 고른 값 → 사실(`owner_stated`, confidence 0.95, 감쇠 없음), 근거로 인터뷰 메시지 id.
- 고르지 않은 보기 → 그 값의 음의 근거(이후 같은 값 추론 확신도 상한 0.3).
- "다른 거예요" 입력 → 같은 슬롯 값으로 파싱(모델), 주인 말이므로 `owner_stated`.
- "건너뛰기" → 30일 동안 다시 묻지 않음.
- **연쇄 갱신**: 답으로 의존 슬롯 재계산(직장 확정 → 그 도메인 메일의 서명에서 역할 후보 가중).
- 끝나면 **"이렇게 이해했어요" 요약 카드**: 묶음별 5줄 이내, [맞아요] [고칠게요] 버튼. "고칠게요"는 해당 슬롯 질문으로.

### 3.9 첫날 가치

설정이 끝난 그날 바로 보여줄 것(인터뷰 끝나고 30분 안에):

1. **오늘 요약**: 오늘·내일 일정, 답이 필요한 메일 3개와 **이미 써 둔 답장 초안**(Gmail 초안함, 보내지 않음).
2. **찾아낸 것**: 다가오는 배송·청구·구독 갱신·예약 일정(메일에서), 각각 [알림 받기] 버튼.
3. **내 프로필 카드**: 비서가 아는 10가지 + [고칠게요].
4. **바로 써볼 버튼 4개**: "이번 주 일정 정리", "최근 구독 정리", "자주 사는 것 가격 지켜보기", "저장소 연결하기(개발)".
5. **내일 아침 첫 먼저 말하기**를 예약(시각은 인터뷰 답).

---

## 4. 일 나누기: 앞단 비서와 일꾼

### 4.1 앞단 비서 하나

- 사용자는 **`#비서` 채널 하나(또는 DM)** 에서만 말한다. 스레드 파서가 아니라 대화(AX 2026-10-28 결정). 작업 진행은 작업 스레드로 따로.
- 앞단 비서는 2.1의 루프다. 짧은 일(R0/R1 인라인 도구)은 직접, 긴 일·화면을 쓰는 일·돈 일은 **작업(job)** 으로 일꾼에게 넘긴다.
- 사용자는 일꾼을 직접 부르지 않는다. 비서가 고르고, 결과를 비서 말투로 전한다.

### 4.2 내부 일꾼

| 일꾼 | 하는 일 | 동시 실행 | 플랫폼 |
|---|---|---|---|
| mail | 검색·요약·초안·(카드 뒤) 발송, 수집 | 읽기 4 / 보내기 1 | 전부 |
| calendar | 보기·추가·충돌 확인 | 2 | 전부 |
| research | 웹 조사, 절차 찾기, 가격·예약 오픈 감시 | 2 | 전부 |
| browser | 로그인된 브라우저로 조회·주문 준비·예약·예매, 원격 카드 | **1**(화면 하나) | 전부(Chrome) |
| desktop | 앱 읽기·조작 | **1**(포커스 하나) | macOS(이후 Windows UIA) |
| kakao | PC 카톡 읽기·보내기 | 1 | macOS |
| commerce | 비교·결제 준비 상태기계(browser 위) | 1 | 전부 |
| dev | 저장소 작업, PR | 1(설정으로 2) | 전부 |

일꾼 계약(`src/dispatch/worker.ts`):

```ts
interface Worker {
  kind: WorkerKind;
  concurrency: number;                  // 기본값, 설정으로 덮어씀
  run(job: Job, ctx: WorkerCtx): Promise<JobResult>;   // 멈춤점에서는 waitOwner()로 반환
}
// ctx: secrets(선언한 것만), db, audit, model(민감도 라우팅), report(진행 한 줄), ask(객관식), card(R2/R3), signal(취소)
```

### 4.3 작업 큐, 상태 카드, 스레드

- 테이블 `jobs(id, kind, worker, origin_message_id, args_json, risk, state, attempts, budget, cost, created_at, …)`, `job_events`.
- 상태: `queued → running → waiting_owner(질문·로그인·결재) → running → done | failed | cancelled`, `expired`.
- **상태 카드 하나를 계속 고친다**(AX `life/status.ts`: "뭐 어쩌라고" 교훈). 마지막 줄은 항상 **다음 한 단계**: 비서가 하는 일 또는 주인이 누를 버튼 하나.
- 카드 아래 스레드에 자세한 진행·캡처·로그 요약. 주인이 스레드에 쓴 말은 그 작업의 추가 지시로 들어간다(주인 말이므로).
- 작업이 사람을 기다리면(로그인·2FA·캡차·결제·약관) **원격 카드**(4.6)를 연다. 비서는 그 값을 절대 대신 입력하지 않는다.
- 재시작 복구: 데몬이 다시 뜨면 `running` 작업을 점검. 결제·발송처럼 결과가 불확실한 단계는 **절대 다시 실행하지 않고** 주인에게 확인(AX `web/notices.ts submit_unknown`).
- 중복 방지: (origin 메시지, 도구, 인자 해시)로 멱등키.

### 4.4 동시 실행과 비용 한도

- 일꾼별 동시 실행 수(4.2), 그리고 전역 **무거운 작업 1개**(브라우저·데스크톱·dev 빌드·시뮬레이터는 Mac 전체에서 한 번에 하나 — AX 규칙).
- 작업당 예산: 시간(기본 10분, dev 45분), 모델 비용, 재시도 1회(실패 원인별: 일시 오류만 재시도).
- 하루·한 달 공급자별 비용 상한, 70%에서 한 줄 경고, 100%면 그 공급자 차단 → 다음 후보 또는 대기.
- 대기열 공정성: 같은 우선순위면 종류별 번갈아(AX `fair-queue.ts`).
- 주인이 3분 안에 말하고 있으면 급하지 않은 배경 작업 보고는 미룬다.

### 4.5 개발 일꾼 (사용자 자기 저장소, 명령할 때만)

AX `src/engineer/*`의 핵심만 일반화. 원본 제품 전용(qa 브랜치, 잠금 파일, 보호 경로 목록, 스토어 출시)은 뺀다.

1. **연결**: Discord [저장소 연결] → Claude Code가 GitHub에서 **fine-grained PAT**를 만드는 화면까지 안내(computer use 가능, **로그인·2FA·토큰 복사는 사람**). 권한: 고른 저장소만, Contents RW, Pull requests RW, Metadata R. **Administration·Workflows·Secrets 권한 없음.** 키체인 `github-token:<owner>/<repo>`.
2. **저장소 프로필**(`repos.yaml`, 첫 연결 때 자동 탐지 후 버튼으로 확인): 기본 브랜치, 설치·테스트·린트 명령, 보호 경로(기본: `.github/workflows/**`, `**/migrations/**`, `**/*.env*`, 결제·인증 경로는 사용자가 추가), 구현 도구(Claude Code / Codex CLI).
3. **명령**: "<저장소>에서 로그인 버튼 색 고쳐줘" → 비서가 범위·수용 기준을 한 번 정리해 [시작] 버튼(R1).
4. **작업 공간**: `~/.axkit/repos/<repo>` 미러 → fetch → `git worktree add -b axkit/<topic>-<date>` (기본 브랜치에서).
5. **구현**: `claude -p` 또는 `codex exec`를 **샌드박스**(macOS `sandbox-exec` 프로필 / Linux bubblewrap)에서 실행. 쓰기는 worktree만, 환경 변수에 비밀 없음, 네트워크는 모델 API만. 프롬프트에 결정 완료 명세(범위 포함/제외, 바꿀 호출 경로, 실패 경우, 수용 테스트)와 자기 검토 체크리스트(AX `prompts/engineer/implement.md`).
6. **검사**: 저장소 프로필의 테스트·린트를 별도 샌드박스(네트워크 차단)에서. 실패 원문(head+tail)을 다음 라운드 지시로. 최대 2라운드 + 기계적 실패 유예 1회.
7. **교차 검토(선택)**: 다른 회사 모델이 diff+기준만 보고 P0~P3·신뢰도로 지적, P0/P1·0.7 이상만 막음(AX `verify.ts gateFindings`).
8. **보호 경로·비밀 검사**: 바뀐 파일이 보호 경로에 닿으면 R2 카드(PR 전에). 푸시 전 비밀 검사(gitleaks 있으면 사용, 없으면 내장 정규식).
9. **PR**: `axkit/*` 브랜치 푸시 → PR(요약: 한 일 / 결정 / 검증 안 된 것 / 다음 할 일). Discord에 링크와 한 줄.
10. **절대 머지하지 않는다.** 기본 브랜치에 푸시하지 않는다(코드에서 거부 + 토큰 권한 + 사용자에게 브랜치 보호 켜기를 권장). 강제 푸시 금지.

### 4.6 원격 카드 (사람이 직접 입력하는 화면)

AX `web/card/*`, `desktop/card.ts`: 브라우저 탭 하나(또는 데스크톱 창 하나)를 폰에서 실시간으로 보고 직접 누르고 입력하는 화면.

- 열리는 때: 비밀번호·2차 비밀번호·결제 PIN·OTP·주민번호 뒷자리·캡차·약관(비서가 못 누르는 것)·결제 승인.
- 보안: 127.0.0.1에서만 듣고, 밖에서는 터널(기본: 열려 있는 동안만 `cloudflared` 빠른 터널, 선택: 사용자 도메인 + Cloudflare Access). Discord 버튼(주인만) → 1회용 링크(해시 저장, 프래그먼트로 전달, POST로 소진) → 세션 쿠키·CSRF → 10분·탭·출처 고정.
- 카드가 닫히면 **페이지가 실제로 보여주는 상태로 다음 행동을 정한다**(주인이 결제까지 눌렀으면 다시 결제하지 않음).
- 비서는 카드 화면 프레임에서 입력값을 읽지 않는다(초점 요소의 종류·위치만).

### 4.7 브라우저 엔진

AX는 제3자 AI 브라우저 **Aside**(`aside mcp`, `aside exec`)를 쓴다. ax-kit은 엔진을 어댑터로 둔다:

- 기본: **Playwright + 사용자 전용 Chrome 프로필**(`~/.axkit/browser-profile`, 비서 전용. 주인의 일상 프로필과 분리) + CDP 원격 카드 백엔드(AX `browser-cdp.ts`가 이미 있음).
- 브라우저 에이전트: browser-use류 루프 또는 Claude computer-use 도구. 단계 3회 실패 재계획, 예산 75% 경고, 같은 행동 반복 감지.
- 선택: Aside 어댑터(사용자가 Aside를 쓰면).

### 4.8 회사 모드 (나중)

M4 이후. AX `src/org/*`, `src/teams/*`의 구조를 일반화:

- 팀 레지스트리(yaml: 팀장 등급, 일꾼 등급, 민감도, 채널), 팀장 페르소나 봇(봇마다 3.4 흐름 반복), 결재 원칙(`needs_owner(action)` 단일 출처), 플레이북, 회사 헌장(사용자가 고친 섹션 보존), 회사 위키·기억, 팀장 회의.
- 저장소 어댑터를 Postgres로 전환 권장(여러 팀 동시 쓰기).
- 원본 제품 전용 팀 업무(PG 온보딩, 영업·IR, 앱스토어, CS, KPI, SRE 등)는 가져오지 않고 "플레이북 예시"로만 문서화.

---

## 5. 기능 목록: AX의 모든 에이전트 기능

표기:
- **이식**: `그대로` = 코드 구조 그대로 이식 가능(설정값만) · `일반화` = 원본 사용자 기본값·한국 서비스·원본 제품 연결·Aside 의존을 걷어내야 함 · `플랫폼` = macOS 전용(손쉬운 사용, Swift, AppleScript 등) · `제외` = 원본 제품 회사 업무, 가져오지 않음
- **등급**: 2.5의 R0~R3 (여러 개면 읽기/쓰기 순)
- **사용자 준비**: 사용자가 해야 하는 설정
- **ax-kit**: 들어갈 마일스톤

### 5.1 하네스·대화

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 1 | 에이전트 루프(계획 JSON → 게이트 → 도구 → 답) | `src/chief/chief.ts`, `schema.ts` | 그대로 | — | 모델 공급자 | M1 |
| 2 | 흐름 기반 의도 게이트(후속 말, 버튼 응답, 가능 질문, 고정·이름 확인) | `src/chief/flow.ts` | 일반화(한국어 조사·불용어 → 언어팩) | — | 없음 | M1 |
| 3 | 질문 정책·되묻기 재작성 | `src/chief/ask-policy.ts` | 일반화(한국어 정규식) | — | 없음 | M1 |
| 4 | 묻기 전에 찾기(resolver) | `src/chief/resolve.ts` | 일반화(한국어 관련어 사전) | R0 | 없음 | M1 |
| 5 | 여러 말풍선 + 다음 행동 버튼 | `src/chief/rich.ts` | 그대로 | — | 없음 | M1 |
| 6 | 객관식 질문 버튼 `(선택: …)` | `src/chief/chief.ts`, `flow.ts choiceOf` | 그대로 | — | 없음 | M1 |
| 7 | 대화 문맥 정리·캐시 순서 | `src/chief/context.ts` | 그대로 | — | 없음 | M1 |
| 8 | 결재 카드 3줄 형식 | `src/discord/owner-card.ts`, `src/act/card.ts` | 그대로 | R2/R3 | 없음 | M1 |
| 9 | 자동 실행 사후 보고 + [잘못됨] → 섀도 카드 | `src/act/auto-report.ts`, `shadow.ts`, `shadow-meaningless.ts` | 그대로 | R1/R2 | 없음 | M1 |
| 10 | 우선순위 바닥·위원회(P0~P4) | `src/act/floor.ts`, `gate.ts`, `facts.ts`, `src/council/*`, `policy/priorities.yaml` | 일반화(원본 제품 보호 경로, R0~R3로 단순화) | — | 없음 | M1 |
| 11 | P0 PIN 확인 | `src/guard/pin.ts`, `src/act/p0.ts` | 그대로 | R3 | PIN 설정(선택) | M1 |
| 12 | 전체 정지 `/정지` `/재개` | `src/guard/kill.ts` | 그대로 | — | 없음 | M1 |
| 13 | 주입 검사·출처 격리·`guard.unblock` | `src/guard/injection.ts`, `service.ts` | 그대로 | — | 없음 | M1 |
| 14 | 비밀·개인정보 가림 | `src/ingest/sanitize.ts`, `mask.ts`, `src/web/redact.ts`, `log-sanitize.ts` | 일반화(주민번호 등 → 언어팩) | — | 없음 | M1 |
| 15 | 모델 라우터·계정 분배·차단기·예산·민감도 | `src/llm/*`, `policy/models.yaml`, `src/policy/models.ts` | 일반화(원본 사용자 계정·모델 목록 제거) | — | 키/구독 | M1 |
| 16 | 놓친 말 다시 잡기(heartbeat) | `src/latte/open-loops.ts` | 그대로 | — | 없음 | M1 |
| 17 | 먼저 말하기(조용한 시간·시간당 상한·대화 중 대기) | `src/latte/proactive.ts`, `voice.ts` | 일반화(KST 고정, 한국어 분류, 원본 제품 소식) | R0 | 조용한 시간 | M1 |
| 18 | 회의 후·요청 진행 후속 말 | `src/assist/followups.ts` | 일반화(AX 요청 부분은 원본 제품 파이프라인) | R0 | 없음 | M2 |
| 19 | 비서 품질 지표 | `src/latte/metrics.ts`, `scripts/latte-metrics.ts` | 일반화(한국어 교정 표현) | — | 없음 | M1 |
| 20 | 밤마다 자기 조정(autoresearch, tuned.md, program.md) | `src/latte/autoresearch.ts`, `tuned.ts`, `prompts/chief/program.md` | 그대로 | — | 없음 | M3 |
| 21 | 공개 하네스 릴리스 감시 | `src/harness/watch.ts`, `loop.ts`, `research.ts` | 그대로(선택, 기본 끔) | — | 없음 | M3 |
| 22 | 자기 개선 관찰·제안 | `src/improvement/*` | 일반화 | — | 없음 | M3 |
| 23 | 표준 넘김 요약·head+tail 자르기 | `src/handoff/recap.ts`, `src/head-tail.ts` | 그대로 | — | 없음 | M1 |
| 24 | 알림 라우팅·채널 | `src/notify.ts`, `src/org/router.ts` | 일반화(채널 이름 고정) | — | 없음 | M1 |
| 25 | 슬래시 명령(/사용량 /결재 /할일 /브리핑 /상태 /도움말) | `src/dashboard/commands.ts`, `src/discord/handlers.ts` | 일반화 | R0 | 없음 | M1 |
| 26 | 보류(holds)·나중에 실행(deferred) | `src/holds/*`, `src/act/deferred.ts` | 그대로 | R1 | 없음 | M2 |
| 27 | 워치독·복원력·자가 회복 | `src/daemon/watchdog.ts`, `src/resilience/*` | 일반화(OrbStack 전제 제거) | — | 없음 | M1 |
| 28 | 아침 브리핑 | `src/briefing/*` | 일반화(원본 제품 지표) | R0 | 시각 | M1 |

### 5.2 기억·지식

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 29 | 사실 저장소(출처·범위·확신·감쇠·순위·MMR) | `src/knowledge/store.ts`, `librarian.ts` | 그대로 | R1 | 없음 | M1 |
| 30 | 기억 충돌 해결(add/update/duplicate) | `src/knowledge/reconcile.ts`, `executor.ts` | 그대로 | R1 | 없음 | M1 |
| 31 | 대화 자동 기억("기억해" 없이) | `src/assist/memory.ts` | 그대로 | R1 | 없음 | M1 |
| 32 | `memory.remember` / `memory.forget` | `src/chief/tools.ts`, `src/knowledge/executor.ts` | 그대로 | R1 | 없음 | M1 |
| 33 | 주간 기억 검토 카드 | `src/knowledge/librarian.ts` | 그대로 | R1 | 없음 | M1 |
| 34 | 핵심 프로필 `core.md`·초기 사실 | `src/knowledge/core.ts`, `seed.ts`, `knowledge/core.md` | 일반화(원본 사용자 seed 제거 → 인터뷰가 만듦) | — | 인터뷰 | M1 |
| 35 | 메일에서 배우기(주문·청구·예약·구독 사실) | `src/latte/facts.ts` | 일반화(한국어 상품 별칭) | R1 | 메일 연결 | M1 |
| 36 | 첨부파일 기억(OCR·캡션·가림·사실화) | `src/latte/attachments.ts` | 일반화(한국 신분번호 패턴) | R1 | 없음 | M1 |
| 37 | 지식 그래프·PNG 보기 | `src/graph/*` | 그대로 | R0 | 없음 | M3 |
| 38 | 절차 기억(procedure cache) | `src/life/procedure-cache.ts` | 그대로 | R1 | 없음 | M2 |

### 5.3 수집

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 39 | Gmail 수집 | `src/ingest/gmail.ts`, `src/google/*` | 그대로(각자 OAuth 클라이언트) | R0 | Google OAuth | M1 |
| 40 | 캘린더 수집 | `src/ingest/calendar.ts` | 그대로 | R0 | Google OAuth | M1 |
| 41 | Slack 수집·검색(`slack.search`) | `src/ingest/slack.ts`, `src/apple/service.ts searchSlack` | 그대로 | R0 | Slack 토큰 | M3 |
| 42 | GitHub 알림 | `src/ingest/github.ts` | 그대로 | R0 | gh/토큰 | M2 |
| 43 | Discord DM 수집(macOS 알림 DB) | `src/ingest/discord-dm.ts` | 플랫폼(미검증) | R0 | 전체 디스크 접근 | 보류 |
| 44 | 메일 인증 헤더 판정(위장 메일) | `src/ingest/mail-auth.ts` | 그대로 | — | 없음 | M1 |
| 45 | 메일 분류·무의미 규칙 학습(`rule.ignore`) | `src/classify/*`, `src/mail/*` | 일반화 | R1 | 없음 | M1 |
| 46 | 뉴스 요약(`news.today`) | `src/news/*` | 일반화(피드 목록) | R0 | 관심사 | M3 |

(새로 만듦, AX에 없음: Drive 수집, 로컬 파일 수집, 첫 인터뷰 — 3장)

### 5.4 메일·일정·할 일

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 47 | `mail.search` / `mail.summarize` | `src/chief/tools.ts` | 그대로 | R0 | 메일 연결 | M1 |
| 48 | 메일 답장 초안 자동 작성 | `src/assist/mail-drafts.ts` | 그대로 | R1 | `gmail.compose` | M1 |
| 49 | `mail.send_reply`(확인 카드 뒤 발송) | `src/chief/tools.ts`, `src/act/*`, `src/mail/gate.ts` | 그대로 | R2 | `gmail.compose` | M1 |
| 50 | `calendar.list` / `calendar.add` | `src/org/calendar/*` | 그대로 | R0/R1(참석자 있으면 R2) | Google OAuth | M1 |
| 51 | 할 일 `todo.add/list/done` | `src/events/owner-todo*.ts` | 일반화(원본 사용자 파일 경로 → DB 또는 사용자 파일) | R1 | 없음 | M1 |
| 52 | 리마인더(반복 포함) `reminder.*` | `src/act/reminders.ts`, `recurrence.ts` | 일반화(KST 고정 → 사용자 시간대) | R1 | 없음 | M1 |
| 53 | Apple 미리 알림 `apple.reminders` | `src/apple/reminders.swift`, `service.ts` | 플랫폼 | R1 | 미리 알림 권한 | M3 |
| 54 | Apple 뮤직 `apple.music` | `src/apple/service.ts` | 플랫폼 | R1 | 자동화 권한 | M3 |
| 55 | 카드 경비 청구 메일 `claim.service` | `src/assist/claim-run.ts`, `card-claim.ts` | 일반화(받는 사람·계정 하드코딩 제거, "반복 보고 메일" 일반 기능으로) | R2 | 메일 연결 | M2 |
| 56 | 카드 이용내역 캡처 → 메일 `card.history` | `src/assist/card-history.ts` | 일반화(카드사 사이트) | R0(조회)/R2(메일) | 브라우저 | M2 |

### 5.5 브라우저·심부름

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 57 | `web.lookup` 읽기 조회 | `src/web/lookup.ts`, `src/life/reserve.ts` | 일반화(Aside → 엔진 어댑터) | R0 | 브라우저 | M2 |
| 58 | 웹 작업 큐·로그인 대기/재개·주인 질문 | `src/web/queue.ts`, `auth.ts`, `auth-text.ts`, `questions.ts`, `transport.ts`, `exec-cli.ts`, `mcp.ts`, `result.ts`, `thread.ts`, `notices.ts`, `module-gate.ts` | 일반화(Aside) | — | 브라우저 | M2 |
| 59 | 최저가 비교 `shop.lowest` | `src/life/comparison.ts`, `shop.ts` | 일반화(한국 쇼핑몰 → 지역 팩) | R0 | 브라우저 | M2 |
| 60 | 주문 준비·결제 `shop.prepare`(결제 수단 선호, 재사용, 재준비, 동일 주문 판정, 상태 메시지) | `src/life/checkout.ts`, `pay-pref.ts`, `reuse.ts`, `reprepare.ts`, `offer.ts`, `selection.ts`, `status.ts`, `jobs.ts`, `recheck.ts`, `defaults.ts`, `intent.ts` | 일반화 | R3 | 브라우저, 한도 | M2 |
| 61 | 구매 기록·재구매 넛지 `nudge.*` | `src/life/purchases.ts`, `nudges.ts`, `executors.ts` | 그대로 | R1 | 없음 | M2 |
| 62 | 예약 `reserve.prepare` | `src/life/reserve.ts`, `src/web/reserve-rules.ts` | 일반화 | R2(선결제·수수료면 R3) | 브라우저 | M2 |
| 63 | 예매 `booking.start`(매진 시 새로고침 대기) | `src/life/booking.ts`, `booking-run.ts`, `src/web/booking.ts` | 일반화(SRT 등 한국 사이트, 새로고침 간격 완화) | R3 | 브라우저 | M2 |
| 64 | 쇼핑몰 로그인 유지 | `src/life/keepalive.ts` | 일반화 | R0 | 브라우저 | M2 |
| 65 | 필수 약관 자동 동의 | `src/web/consent.ts` | 일반화(원본 사용자 상시 결정 → **기본 끔**) | R2 | 명시적 켜기 | M2 |
| 66 | 앱 장바구니 넘김 | `src/web/cart-handoff.ts`, `cart-policy.ts` | 일반화(쿠팡 전용) | R2 | 브라우저 | M3 |
| 67 | 승인 화면 캡처(QR·푸시) | `src/web/approval-shot.ts` | 플랫폼(`screencapture`) → 엔진 스크린샷으로 일반화 | R0 | 없음 | M2 |
| 68 | 원격 브라우저 카드(폰으로 직접 입력) | `src/web/card/*` | 일반화(Aside 백엔드 → CDP, 터널) | 사람 | 터널(선택 도메인) | M2 |
| 69 | 지금 브라우저 보기 | `src/web/card/view-command.ts` | 일반화 | R0 | 없음 | M2 |
| 70 | 로그인 화면 폰으로 `screen.remote` | `src/assist/tools.ts` | 일반화 | 사람 | 터널 | M2 |
| 71 | 브라우저 선호 `aside.preference` | `src/web/preferences.ts`, `policy/aside-preferences.yaml` | 일반화 | R1 | 없음 | M2 |
| 72 | 절차 찾기 `procedure.research` | `src/life/procedure.ts` | 그대로 | R0 | 없음 | M2 |
| 73 | 막힌 출처 기록(우회 금지) | `src/life/source-blocks.ts` | 그대로 | — | 없음 | M2 |
| 74 | 브라우저 점검(doctor) | `src/web/doctor.ts` | 일반화 | — | 없음 | M2 |

### 5.6 생활 정보

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 75 | 장소 검색 `place.search`(근처 약국·병원 포함) | `src/assist/kr-apis.ts`(카카오·네이버 지역) | 일반화(지역 팩: ko=카카오/네이버, 그 외 Google Places/OSM) | R0 | API 키 | M2 |
| 76 | 음식 추천·주문 `food.suggest` / `food.order` | `src/assist/tools.ts` | 일반화(배달 앱 사이트) | R0 / R3 | 위치, 브라우저 | M2 |
| 77 | 날씨·미세먼지 `weather.now` | `src/assist/kr-apis.ts`(open-meteo) | 그대로(미세먼지 등급표만 지역별) | R0 | 없음 | M1 |
| 78 | 택배 조회 `parcel.track` | `src/assist/kr-apis.ts sweetTracker`, `tools.ts findParcels` | 일반화(한국 택배사) | R0 | API 키 | M2 |
| 79 | 지하철 도착 `transit.arrival` | `src/assist/kr-apis.ts subwayArrival` | 일반화(서울 API) | R0 | API 키 | M3 |
| 80 | 길찾기·출발 알림 `route.find` / `route.skip` | `src/transit/*` | 일반화 | R0 | 집·회사 | M3 |
| 81 | 가격·예약 오픈 지켜보기 `watch.*` | `src/assist/watch.ts` | 일반화(네이버 쇼핑 API → 지역 팩, 없으면 브라우저 조회) | R1 | (선택) API 키 | M2 |
| 82 | 지출 정리 `spend.summary` | `src/assist/spend.ts` | 일반화(한국 카드 문자·메일 양식) | R0 | 메일/폰 | M2 |
| 83 | iPhone 단축어 webhook(걸음·위치·화면 시간·카드 문자) `phone.status` | `src/assist/phone.ts`, `docs/guides/iphone-shortcut.md` | 일반화(원본 사용자 호스트 제거, Android는 Tasker 안내) | R0 | 단축어 설치, 터널 | M2 |
| 84 | 위치 판단(말한 곳 > 폰 > 집) | `src/assist/geo.ts` | 그대로 | — | 집(인터뷰) | M2 |

### 5.7 macOS 전용

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 85 | PC 카카오톡 읽기·보내기 `kakao.chats/read/send` | `src/kakao/kmsg.ts`, `service.ts`, `unread.swift` | 플랫폼 | R0 / R2 | 카톡 Mac 앱, 손쉬운 사용 권한, kmsg | M3 |
| 86 | 데스크톱 앱 제어 `desktop.apps/read/screenshot/act` | `src/desktop/ax.swift`, `driver.ts`, `policy.ts`, `service.ts` | 플랫폼 | R0 / R1 / R2 | 손쉬운 사용·화면 기록 권한 | M3 |
| 87 | 데스크톱 원격 카드(창 하나를 폰으로) | `src/desktop/card.ts` | 플랫폼 | 사람 | 터널 | M3 |

### 5.8 개발

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 88 | 개발 파이프라인(worktree, 샌드박스, 명령 허용 목록, 검사, 교차 검증, best-of-N, PR, CI 확인) | `src/engineer/*` | 일반화(원본 제품 qa 브랜치·잠금 파일·보호 경로·출시 제거, 머지 단계 제거) | R1(PR) / R2(보호 경로) | GitHub 토큰, Claude Code/Codex CLI | M2 |
| 89 | 푸시 전 비밀 검사 | `src/engineer/secret-guard.ts` | 일반화(원본 사용자 스크립트 경로 → 내장/gitleaks) | — | 없음 | M2 |
| 90 | 작업 상태 답하기 `ax.work_status` / `ax.engineer_status` / `engineer.redirect` | `src/chief/work-status.ts`, `engineer-status.ts` | 일반화(→ `job.status`) | R0 | 없음 | M2 |
| 91 | 비서 개선 요청 `ax.improve` / `pm.request` / `pm.propose` | `src/assist/tools.ts`, `src/pm/*` | 일반화(→ 자기 저장소 개발 명령) | R1 | 없음 | M2 |
| 92 | 오늘 개발한 것 요약(캡처·영상) | `src/latte/dev-digest.ts` | 일반화(원본 제품 → 연결 저장소의 PR 요약) | R0 | 없음 | M3 |
| 93 | 앱 화면 보여주기 `screen.show` | `src/qa/show.ts`, `src/qa/*` | 플랫폼(시뮬레이터·에뮬레이터) | R0 | Xcode/Android SDK | 보류 |

### 5.9 회사 모드 (나중) 와 원본 제품 전용

| # | 기능 | AX 위치 | 이식 | 등급 | 사용자 준비 | ax-kit |
|---|---|---|---|---|---|---|
| 94 | 팀 레지스트리·작업 배정 `org.assign` | `src/org/registry.ts`, `runtime.ts`, `service.ts`, `policy/org.yaml` | 일반화 | R1 | 팀 정의 | M4 |
| 95 | 팀장 회의 `org.meeting` | `src/org/meetings.ts`, `meeting-forum.ts` | 일반화 | R1 | — | M4 |
| 96 | 회사 기억·위키 `org.recall` | `src/org/wiki.ts`, `library.ts`, `src/intel/*` | 일반화 | R0 | — | M4 |
| 97 | 결재 원칙(`needs원본 사용자`)·결정 묶음 | `src/org/decision-policy.ts`, `decisions.ts`, `decision-batch.ts`, `policy/decisions.yaml` | 일반화 | — | — | M4 |
| 98 | 플레이북·회사 헌장 | `src/org/playbooks.ts`, `charter.ts`, `policy/playbooks.yaml` | 일반화 | — | — | M4 |
| 99 | 팀 페르소나 봇·아바타 | `src/discord/personas.ts`, `avatar.ts`, `announce.ts` | 그대로 | — | 봇 추가 생성 | M4 |
| 100 | 출시 예측·회사 일정 `org.forecast` / `org.calendar` | `src/org/forecast`, `src/org/calendar` | 일반화 | R0 | — | M4 |
| 101 | 다른 비서와 협업(A2A) | `src/a2a/*` | 일반화 | R2 | — | M4 |
| 102 | 원본 제품 지식·코드 검색 `<product>.kb/code/ask/dev` | `src/<product>/*` | 제외(→ #88·#96으로 대체) | — | — | — |
| 103 | 원본 제품 이벤트 라우터 `<product>.event` | `src/events/router.ts`, `detect.ts`, `registry.ts`, `policy/event-jobs.yaml` | 제외 | — | — | — |
| 104 | PG 온보딩 `pg.scan/status`, 영업·IR·계약·크리에이터·신뢰 | `src/pg/*`, `src/org/sales`, `ir`, `contracts*`, `creator`, `trust` | 제외 | — | — | — |
| 105 | 원본 제품 운영 팀(CS·스토어·KPI·SRE·보안 스캔·취약점·성능·디자인·마케팅·SNS·법무·재무) | `src/cs`, `src/store`, `src/kpi`, `src/sre`, `src/security`, `src/sentinel`, `src/advisories`, `src/perf`, `src/teams/*` | 제외(플레이북 예시로만) | — | — | — |

### 5.10 집계

| 분류 | 개수 |
|---|---|
| 그대로(portable) | 36 |
| 일반화(generalize) | 57 |
| 플랫폼 전용(macOS) | 8 |
| 제외(원본 제품 전용) | 4 |
| **합계** | **105** |

플랫폼 전용 8개: Discord DM 수집, Apple 미리 알림, Apple 뮤직, 카카오톡, 데스크톱 앱 제어, 데스크톱 원격 카드, 앱 화면 보여주기(시뮬레이터), 승인 화면 캡처(엔진 스크린샷으로 일반화 예정).

---

## 6. 안전과 법

### 6.1 돈

- 모든 결제·선결제 예약·유료 구독은 **R3**: 카드(금액·상점·상품·수량·배송지 그대로) + 재확인(모달 확인 문구 또는 PIN).
- 금액·상품 동일성은 **글자 비교가 아니라 강한 키**(표시된 결제 금액, 상품 id, 수량, 판매자)로 판정(AX `life/offer.ts`). 카드 이후 값이 바뀌면 새 카드.
- 자동 결제 한도 기본 **0원**. 사용자가 올려도 하루·한 달 상한, 처음 거래하는 상점은 항상 카드.
- 결과가 불확실한 결제는 **절대 재시도하지 않는다**. 주인이 사이트에서 확인.
- 송금·이체·투자·암호화폐는 도구 자체가 없다(금융 앱은 데스크톱에서 읽기 전용).

### 6.2 비밀번호·PIN·카드번호는 절대 입력하지 않는다

- 비서·일꾼·모델은 비밀번호, 2차 비밀번호, 결제 PIN, OTP, 카드번호, 주민번호 뒷자리를 **묻지도, 받지도, 입력하지도 않는다**. 채팅에 오면 즉시 가리고 저장하지 않으며 "원격 카드에서 직접 입력해 주세요"로 답한다.
- 브라우저 자동 로그인은 브라우저 자체 저장 비밀번호(autofill)만. 데스크톱 도우미는 보안 입력 필드에 입력을 거부한다.
- 비밀번호 관리자 앱은 읽기도 금지(앞으로 가져오기만).

### 6.3 밖으로 보내는 일은 주인 명령으로만

- 메일·카톡·게시·초대·제출은 R2. 주인 메시지에 보내기 명령이 있고(흐름 게이트), 보낼 글이 주인 말에 고정되어 있거나 주인이 카드에서 본 그대로일 때만.
- 메일·웹 내용이 "답장해 달라"고 해도 행동하지 않는다(데이터).
- 초안은 R1(보내지 않으므로). 초안에는 돈·날짜 약속을 넣지 않는다.

### 6.4 데이터는 로컬에

- 원본 데이터(메일, 파일, 카톡, 위치, 지출, 첨부)는 사용자 컴퓨터의 DB·폴더에만.
- 모델로 나가는 것은 필요한 조각만, 민감도 라우팅을 거쳐서. 공급자별로 "무엇이 나갔는지" 감사 기록.
- ax-kit 제작자에게 가는 데이터는 없다(텔레메트리 없음).
- `axkit export` / `axkit wipe`: 전부 내보내기·지우기(키체인 항목 포함).

### 6.5 약관(ToS) 고려

| 대상 | 위험 | 대응 |
|---|---|---|
| **KakaoTalk** | 카카오 이용약관은 비정상적 방법·자동화 수단으로 서비스를 이용하는 것을 금지하는 취지의 조항이 있다. kmsg는 서버 프로토콜이 아니라 Mac 앱 화면(손쉬운 사용)을 조작하지만, 계정 제한 위험은 남는다. | 기본 꺼짐, 별도 선택 연결기(공식 저장소에서 분리 배포 검토), 보내기는 매번 카드, 대량·반복 발송 금지(분당 상한), 사용자 동의 화면에 위험 명시 |
| **쇼핑·예매 사이트** | 다수 사이트 약관이 로봇·스크래핑·자동 구매를 금지. 예매 새로고침은 매크로로 보일 수 있음. | 사용자 본인 계정·본인 구매만, 사람 속도, 캡차 절대 풀지 않음, 차단되면 그날 그 출처 제외(우회 금지), 예매 새로고침 간격 기본 5초 이상(AX의 1초는 원본 사용자 개인 설정), 되팔기용 대량 구매 도구 없음 |
| **Discord 봇 만들기(computer use)** | Discord는 사용자 계정 자동화(self-bot)를 금지. 개발자 포털 조작은 사용자 계정으로 하는 웹 조작이다. | 사용자가 지켜보는 상태에서 몇 번의 클릭만, 로그인·2FA·캡차·약관은 사람, 실패 시 수동 안내서. **사용자 Discord 클라이언트로 메시지를 보내는 자동화는 하지 않는다**(봇 토큰으로만) |
| **Google** | Google API Services User Data Policy(Limited Use) | 사용자 자신의 OAuth 클라이언트, 데이터는 사용자 본인에게만 쓰임, 광고·판매 없음 |
| **모델 공급자** | 구독(Claude Pro/Max, ChatGPT)을 제3자 제품의 백엔드로 쓰는 것은 약관상 제한될 수 있음 | 기본은 API 키. 구독 CLI는 사용자 컴퓨터에서 사용자 본인 작업에 공식 CLI를 쓰는 경우만, 문서에 명시, 결정 필요 필요(9장) |
| **GitHub** | 자동화 계정·토큰 정책 | 사용자 토큰, 사용자 저장소만, PR만 |

### 6.6 사람에게 남기는 일

- 로그인, 2FA, 캡차, 본인인증(간편인증 포함)
- 약관·개인정보 동의(필수 동의 자동 체크는 사용자가 명시적으로 켠 경우만, 선택 동의는 절대 안 함)
- 비밀번호·PIN·카드번호·주민번호 입력
- 실제 결제 승인, 송금
- 토큰 복사·키 입력
- 머지·배포·출시
- 계정 삭제·해지·권한 변경의 최종 클릭
- 다른 사람에게 처음 연락하는 것(첫 발송은 항상 카드)

---

## 7. AX에서 가져오기 전에 뺄 것

코드를 옮길 때마다 아래를 확인한다(옮기는 PR의 체크리스트로 사용).

**원본 사용자 개인 설정·데이터**
- `~/.ax-hq/*` 전체(config.json, accounts, attachments, backups, evals 등) — 아무것도 복사하지 않는다.
- `knowledge/core.md`, `knowledge/company/*`, `knowledge/wiki/*`, `src/knowledge/seed.ts`의 초기 사실.
- `prompts/chief/system.md`의 페르소나(페르소나 이름·호칭)와 실제 사례 문장(맥북 주문, 신문고 민원 등) → 중립 예시로 새로 씀. 페르소나 이름은 사용자가 고름.
- `prompts/chief/tuned.md`(원본 사용자 대화로 학습됨), `latte_eval_cases`(DB).
- `policy/life.yaml`(자동 결제 10만 원 등), `policy/decisions.yaml`(원본 사용자 상시 결정: 필수 약관 자동 동의 등), `policy/aside-preferences.yaml`.
- 시간대 KST 하드코딩(`scheduler.ts formatKst` 등) → 사용자 시간대.

**비밀**
- 키체인 서비스 `ax-hq`의 모든 항목, `phone-hook-token`, Discord 봇 토큰들, 페르소나 봇 토큰.
- `src/web/card/settings.ts`의 Cloudflare Access 이메일·팀 도메인, `~/.cloudflared/ax-card.yml` 호스트(원격 카드·폰 webhook용 회사 도메인 두 개).
- `error.log`(실행 로그, 개인 데이터 포함 가능) — 복사 금지.

**원본 제품 전용 파이프라인**
- `src/<product>/*`, `src/pm/<product>.ts`, `src/events/*`(원본 제품 이벤트), `src/store/*`, `src/cs/*`, `src/kpi/*`, `src/pg/*`, `src/sre/*`, `src/perf/*`, `src/qa/*`, `src/teams/design-*`, `src/org/sales`, `ir`, `contracts`, `creator`, `trust`, `<product>-briefing.ts`.
- `src/engineer/lock.ts`(`진행중-작업.md` 공유 잠금), `worktree.ts`의 `origin/qa` 기준, `protected.ts`·`policy/priorities.yaml`의 `<product>-v2` 보호 경로, `release*.ts`, `owner-release-gate.ts`, `final-qa.ts`.
- `src/engineer/secret-guard.ts`의 `~/.config/<product>/git-hooks/secret_guard.py` 고정, `git-credential.ts`·`src/daemon/github.ts`의 원본 제품 GitHub 로그인.
- `migrations/*`의 원본 제품 테이블(새 스키마로 다시 씀).

**하드코딩된 사람·계정** (`grep`로 확인된 것)
- 이메일: 원본 사용자 회사 메일(28곳), 원본 제품 고객지원 주소 2개, 개인 Gmail 2개, 프리랜스 회사 주소 4개(카드 경비 청구 수신·참조·발신 계정). 이 문서에는 주소를 적지 않는다.
- `src/llm/accounts.ts`의 Claude 계정 2개·요금제 메모.
- 장소: `src/assist/geo.ts`·`transit/origin.ts`·`graph/query.ts`의 집·회사 위치(예: 특정 역 이름).
- Discord 채널 이름·id(`비서 채널`, `#결재`, `#일상` 등), owner id.
- 확인 방법: 금지 단어 목록(원본 사용자 이름·회사·도메인·주소·페르소나 이름·`KST` 등)을 **저장소 밖** 파일(`~/.axkit-dev/denylist.txt`)에 두고, 옮긴 파일에 대해 `grep -rnFf ~/.axkit-dev/denylist.txt`가 0건이어야 커밋(pre-commit 훅). 목록 자체가 개인 정보라 저장소에 넣지 않는다.

---

## 8. 마일스톤

노력은 "AX 코드를 참고하는 1명 + 코딩 에이전트" 기준의 대략치.

### M1 — 설치 + Discord 봇 + 지식 만들기 + 인터뷰 + 비서 핵심 (약 5~7주)

- 설치·`axkit` CLI·`doctor`·키체인(macOS 먼저, Linux secret-tool)·SQLite 스키마·데몬(launchd)
- Claude Code 설정 스킬, Discord 봇 생성(computer use + 사람 확인 지점 + 수동 안내서)
- 연결기: Gmail, Google Calendar, Google Drive, 로컬 파일(각자 OAuth 클라이언트)
- 수집 파이프라인·예산·결정적 추출·모델 추출
- 가설 기반 객관식 인터뷰, 요약 카드, 첫날 가치
- 하네스: 루프, 문맥 조립, 지시 출처 경계, 흐름 게이트(ko 언어팩), R0~R3·카드·정지, 여러 말풍선·버튼, 자동 기억(출처·감쇠·충돌·주간 검토), 모델 라우팅(API 키 + 민감도 + 차단기 + 예산), manifest 로더, 감사·llm_calls·`/상태` `/사용량`
- 도구: 메일 검색·요약·초안·발송(카드), 일정, 리마인더, 할 일, 기억, 날씨, 먼저 말하기·heartbeat·아침 브리핑

### M2 — 일꾼: 브라우저·심부름·개발 (약 5~6주)

- 작업 큐·상태 카드·스레드·동시 실행·비용 한도
- **개발 일꾼**(저장소 연결, worktree, 샌드박스, Claude Code/Codex CLI, 검사, 교차 검토, PR, 머지 안 함) — 개발이 "지금" 범위라 M2 첫 순서
- 브라우저 엔진 어댑터(Playwright+전용 프로필), 원격 카드+터널, web.lookup, 절차 찾기·절차 기억
- 쇼핑 비교·주문 준비(R3), 예약·예매, 로그인 유지, 구매 기록·넛지, 가격 지켜보기
- 지출 정리, 카드 내역 캡처 메일·반복 보고 메일, iPhone 단축어, 장소·음식·택배(ko 지역 팩)

### M3 — macOS 팩 + 자기 조정 (약 4주)

- 카카오톡(선택 연결기), 데스크톱 앱 제어 + 데스크톱 원격 카드, Apple 미리 알림·뮤직
- 밤마다 자기 조정(autoresearch), 품질 지표, 지식 그래프, 자기 개선 제안, (선택) 하네스 감시
- Slack, 뉴스, 교통(ko 지역 팩), 오늘 개발한 것 요약
- Linux 동등성 점검, en 언어팩

### M4 — 회사 모드 (약 5~6주, 선택)

- Postgres+pgvector 어댑터, 팀 레지스트리·페르소나 봇·결재 원칙·플레이북·헌장·위키·회의·A2A
- Windows 지원(키체인=Credential Manager, 데스크톱=UI Automation) 여부는 결정 필요

---

## 9. 정해야 할 것

1. **이름** (ax-kit은 가칭)
2. **라이선스**: MIT / Apache-2.0(특허 조항) / AGPL(서비스로 돌려도 공개 의무) / 소스 공개만(비상업)
3. **공개 범위**: 처음부터 공개 / 비공개 후 공개 / 초대한 사람만
4. **먼저 지원할 OS**: 권장 macOS 먼저(카톡·데스크톱·Apple 기능이 macOS), Linux는 M3, Windows는 M4 이후
5. **기본 언어**: 한국어 먼저 + 영어 팩 / 영어 먼저
6. **구독 CLI 사용**: Claude·ChatGPT 구독을 CLI로 쓰는 경로를 기본에 넣을지(약관 위험) vs API 키만 공식 지원
7. **카카오톡 연결기**: 공식 저장소에 포함 / 별도 저장소 분리 / 빼기
8. **한국 생활 서비스**(카카오·네이버·스윗트래커·서울 지하철·한국 쇼핑몰): 기본 포함 / 지역 팩으로 분리
9. **브라우저 엔진**: Playwright 기본 + Aside 선택 어댑터(권장) / Aside 필수
10. **원격 카드 터널**: Cloudflare 빠른 터널 기본(계정 불필요) / 사용자 도메인+Access 필수
11. **페르소나**: 사용자가 이름·성격을 고름(권장) / 비서 기본 제공
12. **AX와의 관계**: 나중에 AX가 ax-kit 코어를 가져다 쓸지(공통 코어) / 영구 분리
13. **필수 약관 자동 동의·자동 결제 한도**: 아예 기능 제외 / 기본 끔(권장)
