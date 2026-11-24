# ax-kit (가칭)

맥미니에 설치하는 1인용 AI 비서. 디스코드(또는 앱 채널)에서 대화하고, 휴대폰 신호는 단축어/자동화 파일로 보낸다.
비서 이름은 설치할 때 정한다.

> 상태: **M5a 코드 완료** (실계정·실기기 확인은 남음). 처음 상태: M0 뼈대 — core(설정·플러그인·이벤트·스케줄러·LLM 게이트웨이·Keychain·확인 정책·SQLite), 디스코드 채널,
> "안녕"에 답하는 스킬, CLI(`setup`·`doctor`·`start`·`secret`)까지.
> 구조: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 비서 동작 규칙: [docs/DESIGN.md](docs/DESIGN.md)

> **비공개 저장소.** 초대받은 사람만 본다. 밖으로 공유·포크·공개 전환하지 말 것. 비밀값(키·토큰·서명 파일·`Local.xcconfig`·`local-device.yml`)은 저장소에 두지 않는다
> (`.gitignore`), 올리기 전 `gitleaks git .`로 확인.

## 설치 요약

**한 번에 설치(맥):** 이 저장소에서 `bash install.sh`. Node·pnpm이 없으면 설치하고, 패키지를 받은 뒤 `ax-kit` 명령을 연결하고 `ax-kit setup`을 엽니다. 몇 번 실행해도 안전합니다.

- `ax-kit setup`: 처음이면 7단계만 물어요(비서 → AI 연결 → 대화할 곳 → 메일·캘린더 → 기본 기능 → 알림 → 처음 알아보기, ↑↓로 고르고 Enter, 여러 개는 Space, "직접 입력" 가능). 끝에 "이렇게 설정했어요" 요약이 나와요. 이미 설정돼 있으면 켜진·꺼진 기능 표를 보여 준 뒤 **꺼진 것만** 이어서 설정(AI 연결, Google, 첫 문서 살펴보기 → 회사별 팀, launchd, 앱 짝 맞추기 QR)하거나 선택 기능을 고를 수 있어요.
- `ax-kit setup features` (= `ax-kit features add`): 선택 기능(카톡 PC 읽기, 개발 보조, 받아쓰기, 앱 개발 준비 등)을 켜고 끄기. 특정 일에만 쓰는 팩(인재 소개 등)은 묻지 않고, 처음 알아보기가 끝나면 비서가 맞는 것을 제안해요.
- `ax-kit features`: 지금 켜진 기능과 꺼진 기능, 켜는 법. 앱은 서버가 알려 준 기능만 보이므로 "앱에 왜 안 보이지?"의 답이 여기 있습니다.
- `ax-kit update`: 새 코드(fast-forward만) → 패키지 → 백그라운드 서비스 재시작.

1. 서버(맥): `pnpm install` → `pnpm ax-kit setup`(이름·언어·채널 `discord|app|both`·LLM 키, 비밀은 Keychain) → `pnpm ax-kit doctor` → `pnpm ax-kit service install`(로그인 시 자동 시작) 또는 `pnpm ax-kit start`.
2. 클라이언트 앱(iOS·Android·맥 데스크톱)은 별도 저장소(ax-kit-ios·ax-kit-android·ax-kit-desktop)에 있다. 맥 앱은 `ax-kit phone install-mac`으로 이 맥이 다른 맥에 설치·연결해 준다. 서버와 앱의 약속은 [APP-PROTOCOL.md](docs/APP-PROTOCOL.md).
3. 선택: 푸시(APNs .p8을 Keychain `app.apns.key`에), 브라우저 작업, 회사 모드 등은 `config.plugins.<id>`로 켠다(기본 꺼짐).

## 해 보기

```bash
pnpm install
pnpm ax-kit setup      # 객관식 질문 → ~/.ax-kit/config.json, 비밀은 Keychain
pnpm ax-kit doctor     # 무엇이 빠졌는지
pnpm ax-kit start      # 봇에게 DM으로 "안녕"
```

필요: macOS, Node 22.13+, pnpm.

## 개발

```bash
pnpm check             # tsc + eslint(계층 규칙 포함) + vitest
```

- 계층: `core` ← `channels` / `connectors` / `skills` / `mobile` ← `app` ← `cli`. 거꾸로 import하면 lint 오류.
- 기능은 플러그인으로 추가한다(`src/app/plugins.ts`에 등록, `config.plugins.<id>.enabled`로 끄고 켬).
- 보내기·결제·삭제 효과가 있는 도구는 설정과 상관없이 항상 주인 확인을 거친다.

## 휴대폰 연결

```bash
pnpm ax-kit phone pair --platform ios      # 또는 android
pnpm ax-kit phone list
pnpm ax-kit phone rotate <기기 id>
pnpm ax-kit phone revoke <기기 id>
```

터미널에 QR과 6자리 코드가 나온다. 휴대폰으로 QR을 열고 코드를 넣으면 단축어(iOS) 또는 `.macro` 파일
(Android)을 내려받는다. 밖에서도 신호를 받으려면 Tailscale Funnel로 `/m` 경로만 연다.
안내: [iPhone](docs/guides/phone-ios.md) · [Android](docs/guides/phone-android.md) ·
[Tailscale Funnel](docs/guides/tailscale-funnel.md). `pnpm ax-kit doctor`가 휴대폰 마지막 신호를 확인한다.

## 앱 채널

클라이언트 앱은 새로 만든다(2026-11-19, 이전 Android·iOS·Tauri 앱은 git 기록에만 남음).
서버 쪽 앱 채널(`src/channels/app`, `src/mobile/app-*`)과 프로토콜 명세 [APP-PROTOCOL.md](docs/APP-PROTOCOL.md)는 남겨 두었다 — 새 앱이 그대로 쓰거나 고쳐 쓴다.

## 한국 생활 기능 키

언어가 `ko`이면 날씨·미세먼지·장소·지하철·택배·최저가 도구가 기본으로 켜진다. 각 기능은 공공 API 키가 있어야 하고,
없는 키는 그 도구만 안내 문구로 답한다(`needs_key`). 키는 Keychain에만 저장한다.

| 키 | 쓰는 기능 | 받는 곳 |
|---|---|---|
| `ko.data-go-kr.key` | 날씨·미세먼지·버스 정류장 | data.go.kr |
| `ko.seoul-data.key` | 지하철 실시간 도착 | data.seoul.go.kr |
| `ko.kakao.rest-key` | 장소 검색·지오코딩 | developers.kakao.com |
| `ko.sweettracker.key` | 택배 조회 | sweettracker.co.kr |
| `ko.naver.client-id` / `ko.naver.client-secret` | 최저가 검색 | developers.naver.com |

```bash
pnpm ax-kit secret set ko.kakao.rest-key   # 키는 숨김 입력으로 넣는다
pnpm ax-kit doctor                          # 어떤 키가 빠졌는지 이름만 보여 준다
```

## 돈·서류·여행 (M3)

- **지출 장부**: 휴대폰 카드 문자·앱 알림, 메일 영수증을 자동으로 장부에 넣는다(카드번호는 저장 안 함). 매월 1일 리포트, 말일 확인 카드.
- **구독**: 장부에서 반복 결제를 찾아 갱신 3일 전·가격 인상 때 알린다. 해지는 방법만 안내한다.
- **경비 청구**: 설정이나 대화로 규칙을 만든다(예: 평일 점심 식대, 업무용 AI·인프라). 매월 청구 요약과 메일 초안까지 만들고, 보내기는 항상 승인.
- **감시**: `watch.add`로 최저가·상품 페이지 가격·재입고·페이지 변화를 본다.
- **영수증·서류**: Gmail의 영수증·인보이스·계약서를 `~/.ax-kit/files/vault`(700/600)에 보관하고 월말에 요약한다.
- **여행 묶음**: 예약 확인 메일을 여행 단위로 묶고 D-3·D-1 체크리스트를 보낸다.
- **파일**: `plugins["connector.local-files"] = { "enabled": true, "folders": ["~/Documents/notes"] }`, Drive는 `ax-kit connect google`에서 고른다.
  키·비밀번호·신분증처럼 보이는 파일은 읽지 않는다.

```bash
pnpm ax-kit phone funnel          # Tailscale Funnel 단계별 점검 (--fix: /m 경로만 물어보고 연결)
pnpm ax-kit phone template --out ./tpl   # iCloud 링크용 단축어 템플릿(주소·토큰 없음)
```

## 처음 알아보기·지식 문서 (M5a)

- `ax-kit setup` 마지막에 "처음 알아보기"를 물어본다. 동의하면 고른 폴더(문서·데스크탑·다운로드·개발 폴더 중 고름)·Google Drive 최근 문서·
  연결한 메일·캘린더·할 일·대화방 이름을 훑어 `~/.ax-kit/knowledge/`에 `프로필.md`·`프로젝트/*.md`·`분야/*.md`·`README.md`·`변경기록.md`를 만든다.
- 모델에는 원문 대신 가린 파일별 요약만 간다. 키·비밀번호·.env·여권·통장 같은 이름은 열지 않는다.
- 끝나면 디스코드로 "제가 이해한 당신" 카드가 온다. `2 회사는 ○○예요`, `3 삭제`처럼 고치면 그게 최우선 사실이 된다.
- 디스코드에서 `알아보기 멈춰` · `알아보기 계속` · `알아보기 상태` · `다시 알아보기`. 하루 한 번 바뀐 것만 다시 본다.

## 라이선스

미정.
