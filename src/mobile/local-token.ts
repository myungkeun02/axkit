import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The desktop app on this Mac connects without pairing (owner 2026-11-18: "이 PC에서만 쓰는 용도"). On every start the
 * bridge writes a fresh token to `~/.ax-kit/desktop.token` (folder 700, file 600, so only this macOS user can read it)
 * and accepts it only from a loopback address. A token copied to another machine is useless: requests from anywhere
 * but 127.0.0.1 / ::1 are refused, and the next restart replaces it.
 */
export const LOCAL_DEVICE_ID = 'd_LOCALMAC';
export const LOCAL_DEVICE_NAME = '이 맥';
export const LOCAL_TOKEN_FILE = 'desktop.token';

export interface LocalTokenFile {
  v: 1;
  baseUrl: string;
  token: string;
  issuedAt: string;
}

export function localTokenPath(home: string): string {
  return join(home, LOCAL_TOKEN_FILE);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Atomic write: the app never reads a half-written file, and the token is never world-readable even for a moment. */
export async function writeLocalToken(file: string, entry: { baseUrl: string; token: string; now: Date }): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const body: LocalTokenFile = { v: 1, baseUrl: entry.baseUrl, token: entry.token, issuedAt: entry.now.toISOString() };
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}
