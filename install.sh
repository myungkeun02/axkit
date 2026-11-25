#!/bin/bash
# ax-kit one-command install (R18). Safe to run again: every step checks first and skips what is already there.
#   bash install.sh            # from a checkout
#   AX_KIT_DIR=~/ax-kit bash install.sh
set -euo pipefail

# the public release (one commit per version); the development repository stays private
REPO="${AX_KIT_REPO:-myungkeun02/axkit}"
DIR="${AX_KIT_DIR:-}"
say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "ax-kit은 macOS에서 돌아가요."

if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
command -v brew >/dev/null 2>&1 || fail "Homebrew가 필요해요: https://brew.sh 에서 설치한 뒤 다시 실행해 주세요."

need_node() {
  command -v node >/dev/null 2>&1 || return 0
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?1:0)'
}
if need_node; then say "Node.js 설치 (brew install node)"; brew install node; fi
if ! command -v pnpm >/dev/null 2>&1; then say "pnpm 켜기 (corepack)"; corepack enable >/dev/null 2>&1 || npm install -g pnpm; fi

# where the code lives: this checkout, $AX_KIT_DIR, or a fresh clone in ~/ax-kit
if [ -z "$DIR" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$here/package.json" ] && grep -q '"name": "ax-kit"' "$here/package.json"; then DIR="$here"; else DIR="$HOME/ax-kit"; fi
fi
# a copy handed out by the assistant's Mac (no .git) is already the code: never clone over it
if [ ! -d "$DIR/.git" ] && [ ! -f "$DIR/package.json" ]; then
  say "코드 받기 → $DIR"
  if command -v gh >/dev/null 2>&1; then gh repo clone "$REPO" "$DIR"; else git clone "https://github.com/$REPO.git" "$DIR"; fi
fi
cd "$DIR"

say "패키지 설치"
pnpm install --frozen-lockfile

# `ax-kit` on PATH: Homebrew's bin is already on it on most Macs
BIN_DIR="$(brew --prefix)/bin"
[ -w "$BIN_DIR" ] || { BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; }
if [ "$(readlink "$BIN_DIR/ax-kit" 2>/dev/null)" != "$DIR/bin/ax-kit.mjs" ]; then
  ln -sf "$DIR/bin/ax-kit.mjs" "$BIN_DIR/ax-kit"
  say "ax-kit 명령 연결: $BIN_DIR/ax-kit"
fi
# this script found Homebrew itself; a new terminal only does if ~/.zprofile says so — make sure it does
PROFILE="$HOME/.zprofile"
if [ "$BIN_DIR" = "$(brew --prefix)/bin" ]; then
  LINE="eval \"\$($(brew --prefix)/bin/brew shellenv)\""
else
  LINE="export PATH=\"$BIN_DIR:\$PATH\""
fi
if ! grep -qsF "$LINE" "$PROFILE"; then
  printf '\n# ax-kit: the ax-kit command\n%s\n' "$LINE" >> "$PROFILE"
  say "새 터미널에서도 ax-kit이 되게 $PROFILE 에 추가했어요. 지금 창에서는: source $PROFILE"
fi

# A work Mac that only shares its files with the assistant's Mac (docs/guides/remote-sources.md) skips the setup.
if [ "${AX_KIT_NO_SETUP:-}" = "1" ]; then say "설치 끝. 새 터미널을 열고(또는 source $PROFILE) 다음: ax-kit source setup"; exit 0; fi

say "설정 시작 (이미 한 단계는 건너뛰어요)"
exec "$DIR/bin/ax-kit.mjs" setup
