import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import type { Clock } from '../core/scheduler/types.js';
import type { KeyValueStore } from '../core/store/types.js';
import type { RandomBytes } from './devices.js';
import { defaultRandomBytes, randomString } from './devices.js';
import { sendJson, setSecurityHeaders } from './http.js';
import { sourceScript } from './install-source.js';

export const INSTALL_LINKS_KEY = 'installLinks';
/** As long as the pairing code inside it. */
const LINK_TTL_MS = 10 * 60_000;
const MAX_LINKS = 10;
/** Only what a pairing link and a public https address can hold: nothing a shell would read as code. */
const SAFE = /^[A-Za-z0-9:/?=&%._~-]+$/;

export interface InstallLink {
  nonce: string;
  /** What it installs: the desktop app (default) or ax-kit's file-reading side for another Mac. */
  kind?: 'desktop' | 'source';
  /** The desktop app, zipped (`ditto -c -k --keepParent`). */
  zip: string;
  /** This Mac's public https address, which the script downloads from. */
  base: string;
  /** `axkit://pair?…`: the one-time pairing link the installed app opens. */
  pair: string;
  expiresAt: string;
  /** A source install: the address and code the other Mac reported once it was set up. */
  reported?: { url: string; code: string };
}

/**
 * Ten-minute install links for the desktop app on another Mac: one line in its terminal (or over Tailscale SSH)
 * downloads the app from this Mac, puts it in /Applications and opens it already paired. The link holds a pairing
 * code, so it expires with it.
 */
export class InstallLinks {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
    private readonly random: RandomBytes = defaultRandomBytes,
  ) {}

  async create(input: { zip: string; base: string; pair: string; kind?: 'desktop' | 'source'; ttlMs?: number }): Promise<InstallLink> {
    const base = input.base.replace(/\/+$/, '');
    const kind = input.kind ?? 'desktop';
    if (!/^https:\/\//.test(base) || !SAFE.test(base) || (kind === 'desktop' && (!SAFE.test(input.pair) || !input.pair.startsWith('axkit://pair?')))) throw new Error('Unsafe install link');
    const now = this.clock.now();
    const link: InstallLink = { nonce: randomString(this.random, 16), kind, zip: input.zip, base, pair: kind === 'desktop' ? input.pair : '', expiresAt: new Date(now.getTime() + (input.ttlMs ?? LINK_TTL_MS)).toISOString() };
    await this.kv.set(INSTALL_LINKS_KEY, [...(await this.fresh(now)), link].slice(-MAX_LINKS));
    return link;
  }

  /** The other Mac's answer to a source install, kept once (a second report is refused). */
  async report(nonce: string, reported: { url: string; code: string }): Promise<boolean> {
    const now = this.clock.now();
    const links = await this.fresh(now);
    const link = links.find((item) => item.nonce === nonce);
    if (link === undefined || link.kind !== 'source' || link.reported !== undefined) return false;
    link.reported = reported;
    await this.kv.set(INSTALL_LINKS_KEY, links);
    return true;
  }

  async find(nonce: string): Promise<InstallLink | undefined> {
    return (await this.fresh(this.clock.now())).find((link) => link.nonce === nonce);
  }

  private async fresh(now: Date): Promise<InstallLink[]> {
    const stored = await this.kv.get<InstallLink[]>(INSTALL_LINKS_KEY);
    return (Array.isArray(stored) ? stored : []).filter((link) => Date.parse(link.expiresAt) > now.getTime());
  }
}

/** The one line to run on the other Mac (a source install keeps the terminal for its questions). */
export function installCommand(link: Pick<InstallLink, 'base' | 'nonce' | 'kind'>): string {
  return link.kind === 'source' ? `bash -c "$(curl -fsSL ${link.base}/m/install/${link.nonce})"` : `curl -fsSL ${link.base}/m/install/${link.nonce} | bash`;
}

/** The script: macOS only, downloads the app from this Mac, replaces the old copy, opens it with the pairing link. */
export function installScript(link: InstallLink): string {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    '[ "$(uname)" = "Darwin" ] || { echo "이 설치는 macOS에서만 돼요."; exit 1; }',
    `ZIP_URL='${link.base}/m/install/${link.nonce}/app.zip'`,
    `PAIR='${link.pair}'`,
    'TMP="$(mktemp -d)"; trap \'rm -rf "$TMP"\' EXIT',
    'echo "ax-kit 데스크톱 앱을 받는 중이에요…"',
    'curl -fsSL "$ZIP_URL" -o "$TMP/app.zip"',
    'ditto -x -k "$TMP/app.zip" "$TMP/x"',
    'APP="$(find "$TMP/x" -maxdepth 1 -name "*.app" | head -n 1)"',
    '[ -n "$APP" ] || { echo "받은 파일에 앱이 없어요."; exit 1; }',
    'NAME="$(basename "$APP")"',
    'osascript -e "quit app \\"${NAME%.app}\\"" >/dev/null 2>&1 || true',
    'DEST="/Applications"; [ -w "$DEST" ] || DEST="$HOME/Applications"; mkdir -p "$DEST"',
    'rm -rf "$DEST/$NAME" && ditto "$APP" "$DEST/$NAME"',
    'xattr -dr com.apple.quarantine "$DEST/$NAME" >/dev/null 2>&1 || true',
    'open "$DEST/$NAME"',
    'sleep 3',
    'open "$PAIR"',
    'echo "✓ $DEST/$NAME 에 설치했고, 앱이 비서와 연결하고 있어요. 앱 화면을 확인해 주세요."',
    '',
  ].join('\n');
}

const INSTALL_PATH = /^\/m\/install\/([A-Za-z0-9_-]{1,128})(\/app\.zip|\/ax-kit\.tar\.gz)?$/;

/** `GET /m/install/<nonce>` (the script) and `/m/install/<nonce>/app.zip` (the app); unknown or expired: 404. */
export async function installRoute(links: InstallLinks | undefined, path: string, response: ServerResponse): Promise<boolean> {
  const match = INSTALL_PATH.exec(path);
  if (match === null) return false;
  const link = await links?.find(match[1] ?? '');
  if (link === undefined) {
    sendJson(response, 404, { ok: false });
    return true;
  }
  setSecurityHeaders(response);
  if (match[2] === undefined) {
    const body = Buffer.from(link.kind === 'source' ? sourceScript(link) : installScript(link), 'utf8');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    response.setHeader('Content-Length', String(body.length));
    response.end(body);
    return true;
  }
  let data: Buffer;
  try {
    data = await readFile(link.zip);
  } catch {
    sendJson(response, 404, { ok: false });
    return true;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', link.kind === 'source' ? 'application/gzip' : 'application/zip');
  response.setHeader('Content-Length', String(data.length));
  response.end(data);
  return true;
}
