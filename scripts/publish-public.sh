#!/bin/bash
# Publishes a release of ax-kit and its apps to the public repositories, without the development history:
# each run adds one commit with the current code on top of the public repository's own history, so an
# installation that cloned it updates with `git pull --ff-only` (`ax-kit update`).
#   bash scripts/publish-public.sh            # all four
#   bash scripts/publish-public.sh ax-kit     # one
set -euo pipefail

OWNER="${AX_KIT_PUBLIC_OWNER:-myungkeun02}"
DEV_ROOT="${AX_KIT_DEV_ROOT:-$HOME/dev}"
# development folder → public repository
declare -a PAIRS=("ax-kit:axkit" "ax-kit-desktop:axkit-desktop" "ax-kit-ios:axkit-ios" "ax-kit-android:axkit-android")
# words that must never reach a public release (real names, machines); checked before every push
FORBIDDEN="${AX_KIT_FORBIDDEN:-}"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

publish() {
  local src="$DEV_ROOT/$1" repo="$2"
  [ -d "$src/.git" ] || { say "건너뜀: $src 가 없어요"; return; }
  [ -z "$(git -C "$src" status --porcelain)" ] || { echo "✗ $src 에 커밋하지 않은 변경이 있어요" >&2; exit 1; }
  local sha; sha="$(git -C "$src" rev-parse --short HEAD)"
  local work; work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  if gh repo view "$OWNER/$repo" >/dev/null 2>&1; then
    git clone --quiet "https://github.com/$OWNER/$repo.git" "$work/pub"
  else
    say "공개 레포 만들기: $OWNER/$repo"
    gh repo create "$OWNER/$repo" --public --description "ax-kit (release)" >/dev/null
    git init --quiet -b main "$work/pub"
    git -C "$work/pub" remote add origin "https://github.com/$OWNER/$repo.git"
  fi
  # the tree at HEAD only (no history, no ignored or local files)
  find "$work/pub" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  git -C "$src" archive --format=tar HEAD | tar -x -C "$work/pub"
  if [ -n "$FORBIDDEN" ] && grep -r -I -i -l -E "$FORBIDDEN" "$work/pub" --exclude-dir=.git >/dev/null; then
    echo "✗ $repo 에 공개하면 안 되는 단어가 있어요:" >&2
    grep -r -I -i -l -E "$FORBIDDEN" "$work/pub" --exclude-dir=.git >&2
    exit 1
  fi
  git -C "$work/pub" add -A
  if git -C "$work/pub" diff --cached --quiet; then say "$repo: 바뀐 것 없음"; return; fi
  git -C "$work/pub" -c user.name="ax-kit" -c user.email="ax-kit@users.noreply.github.com" commit --quiet -m "release $(date +%Y-%m-%d) ($1 $sha)"
  git -C "$work/pub" push --quiet origin main
  say "$repo: 올렸어요 ($sha)"
}

for pair in "${PAIRS[@]}"; do
  name="${pair%%:*}"
  if [ $# -gt 0 ] && [ "$1" != "$name" ]; then continue; fi
  publish "$name" "${pair##*:}"
done
