# Tailscale Funnel로 휴대폰 연결하기

휴대폰이 집 밖에서도 ax-kit에 신호를 보내려면 맥미니까지의 통로가 필요해요. 기본은 Tailscale Funnel이에요.
**Tailscale은 맥미니에만 설치**하고, 휴대폰에는 아무것도 설치하지 않아요. Funnel은 `/m` 경로 하나만 HTTPS로 공개하고,
암호화는 맥미니에서 끝나요.

## 1. 맥미니에 Tailscale 설치

```bash
brew install --cask tailscale
tailscale up
```

브라우저가 열리면 Tailscale 계정으로 로그인해요. 앱을 설치한 방식이라면 메뉴 막대의 Tailscale 아이콘에서도 같은 일을 해요.

## 2. 관리 콘솔에서 Funnel 켜기

1. https://login.tailscale.com/admin 에 접속해요.
2. **DNS** 페이지에서 **HTTPS 인증서**를 켜요. (Funnel 주소가 `https://…ts.net`이라서 필요해요.)
3. 같은 화면이나 **Access controls**에서 이 기기에 **Funnel** 권한을 켜요. 콘솔 버전에 따라 메뉴 이름이 다를 수 있어요.

## 3. `/m` 경로만 공개

```bash
tailscale funnel --bg --set-path /m http://127.0.0.1:47617/m
tailscale funnel status
```

`status`에 `https://<맥이름>.<tailnet>.ts.net/m` 같은 주소가 보이면 성공이에요. 이 주소를 ax-kit 설정의
`publicUrl`에 넣어요(페어링 때 QR에 들어가는 주소예요). 휴대폰은 `<publicUrl>/m/v1/ingest`로 신호를 보내요.

- `--bg`는 터미널을 닫아도 Funnel이 계속 동작하게 해요.
- `--set-path /m` 덕분에 **`/m` 아래만** 공개돼요. 다른 경로는 밖에서 보이지 않아요.

## 3.1 한 번에 점검하기

```bash
ax-kit phone funnel
```

설치 → 실행·로그인 → MagicDNS 이름 → HTTPS 인증서 → Funnel 권한 → `/m` 경로 → 로컬 브리지 → 공개 주소 순서로
확인하고, 실패한 단계마다 고치는 명령이나 설정 페이지를 한 줄로 알려 줘요. 모두 정상이면 종료 코드가 0이에요.

`--fix`를 붙이면 **`/m` 경로만** 고칠 수 있어요. 그 단계 하나만 실패했을 때 물어보고(기본은 "그대로 두기"),
`tailscale funnel --bg --set-path /m http://127.0.0.1:47617/m`를 실행한 뒤 다시 확인해요. ACL이나 다른 Tailscale
설정은 바꾸지 않아요. 관리 콘솔에서 직접 해야 하는 단계(HTTPS 인증서, Funnel 권한)는 안내만 해요.

## 4. 사설망만 쓰기 (공개 노출 0)

Funnel을 쓰지 않고 Tailscale 사설망(tailnet) 안에서만 연결할 수 있어요.

1. Funnel을 끄고 `serve`로 바꿔요.
   ```bash
   tailscale funnel --set-path /m off
   tailscale serve --bg --set-path /m http://127.0.0.1:47617/m
   tailscale serve status
   ```
2. 휴대폰에 Tailscale 앱을 설치하고 **같은 tailnet 계정**으로 로그인해요.
3. QR의 주소를 `https://<맥이름>.<tailnet>.ts.net`으로 바꿔 페어링해요.

이 방식은 tailnet에 들어온 기기만 접근할 수 있고, 인터넷에는 아무것도 공개되지 않아요. 대신 휴대폰에서 Tailscale이
켜져 있어야 해요.

## 5. 무엇이 밖에 보이나

- 공개되는 것은 **`/m` 경로 하나**뿐이에요. 디스코드 봇, LLM 키, 다른 로컬 포트는 보이지 않아요.
- 브리지 서버는 `127.0.0.1:47617`에만 열려요. Funnel/서브가 유일한 통로예요.
- 요청에는 기기별 Bearer 토큰이 필요하고, `ts`가 ±5분을 벗어나면 거절해요. 본문 크기와 분당 요청 수에도 상한이 있어요.
- 토큰 원문은 휴대폰 파일에만 있고 맥미니에는 해시만 저장해요. Funnel을 통해 토큰이 평문으로 제3자에게 보이지 않아요.

## 6. 상태 확인과 끄기

- `ax-kit doctor`를 실행하면 휴대폰의 마지막 신호 시각과 브리지 상태를 볼 수 있어요.
- `tailscale funnel status`로 공개 경로를 확인해요.
- 공개를 끄려면:
  ```bash
  tailscale funnel --set-path /m off
  tailscale funnel reset
  ```
  사설망만 썼다면 `tailscale serve --set-path /m off`, `tailscale serve reset`을 써요.
- Tailscale 자체를 끄려면 `tailscale down`, 또는 관리 콘솔에서 기기를 제거해요.

## 문제가 생기면

- 주소가 502로 응답하면 ax-kit가 실행 중인지(`ax-kit start`), 포트가 47617인지 확인해요.
- 인증서 오류가 나면 관리 콘솔의 HTTPS 인증서 설정을 확인해요.
- 휴대폰에서 연결이 안 되면 `tailscale funnel status`의 주소와 ax-kit 설정의 `publicUrl`이 같은지 봐요.
