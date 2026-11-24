import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http.js';
import type { InstallLink, InstallLinks } from './install-links.js';

const MAX_REPORT_BYTES = 2048;
const REPORT_PATH = /^\/m\/install\/([A-Za-z0-9_-]{1,128})\/paired$/;
/** Only an address on the tailnet (100.x or *.ts.net) and a pairing code: nothing else is taken from the other Mac. */
const URL_OK = /^http:\/\/(100\.\d{1,3}\.\d{1,3}\.\d{1,3}|[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net):\d{2,5}$/;
const CODE_OK = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

/**
 * The script for another Mac: downloads this assistant's ax-kit, installs it (Node and packages as needed), asks which
 * folders to share (on that Mac's own terminal), starts the file-reading service and reports its pairing code back,
 * so the assistant's Mac finishes the pairing by itself. Nothing on that Mac is changed beyond ~/ax-kit-source.
 */
export function sourceScript(link: InstallLink): string {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    '[ "$(uname)" = "Darwin" ] || { echo "이 설치는 macOS에서만 돼요."; exit 1; }',
    `BASE='${link.base}'`,
    `N='${link.nonce}'`,
    'DIR="$HOME/ax-kit-source"',
    'echo "비서의 맥에서 ax-kit을 받는 중이에요…"',
    'mkdir -p "$DIR"',
    'curl -fsSL "$BASE/m/install/$N/ax-kit.tar.gz" | tar -xz -C "$DIR"',
    'echo "필요한 것을 설치하는 중이에요 (처음에는 몇 분 걸려요)…"',
    'AX_KIT_DIR="$DIR" AX_KIT_NO_SETUP=1 bash "$DIR/install.sh"',
    // the installer may have just put Node in place: find it the way it did
    'for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done',
    'AX="$DIR/bin/ax-kit.mjs"',
    'node "$AX" source setup',
    'node "$AX" source install',
    'node "$AX" source pair "$BASE/m/install/$N/paired"',
    'echo "✓ 이 맥의 고른 폴더를 비서가 읽을 수 있게 연결하고 있어요. 비서의 맥 화면을 확인해 주세요."',
    '',
  ].join('\n');
}

/** `POST /m/install/<nonce>/paired {url, code}`: the other Mac's address and pairing code, once, for a source link. */
export async function reportRoute(links: InstallLinks | undefined, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const match = REPORT_PATH.exec(path);
  if (match === null) return false;
  const parsed = await readJson(request, MAX_REPORT_BYTES);
  const body = typeof parsed === 'object' && parsed !== null && 'value' in parsed ? (parsed.value as Record<string, unknown>) : undefined;
  const url = typeof body?.['url'] === 'string' ? body['url'] : '';
  const code = typeof body?.['code'] === 'string' ? body['code'].toUpperCase() : '';
  if (!URL_OK.test(url) || !CODE_OK.test(code)) {
    sendJson(response, 400, { ok: false, error: 'bad_report' });
    return true;
  }
  const kept = (await links?.report(match[1] ?? '', { url, code })) === true;
  sendJson(response, kept ? 200 : 404, { ok: kept });
  return true;
}
