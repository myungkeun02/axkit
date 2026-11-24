import { join } from 'node:path';
import type { Clock } from '../core/scheduler/types.js';
import { systemClock } from '../core/scheduler/clock.js';
import { openSqliteStore } from '../core/store/sqlite.js';
import type { Store } from '../core/store/types.js';
import { MobileAdmin } from '../mobile/admin.js';
import { ApkLinks } from '../mobile/apk-links.js';
import { InstallLinks } from '../mobile/install-links.js';
import type { PairingFile } from '../mobile/admin.js';
import { DEVICES_KEY } from '../mobile/devices.js';
import type { MobilePlatform } from '../mobile/devices.js';
import { connectionString } from '../mobile/files/ios-import.js';
import { buildIosShortcuts } from '../mobile/files/ios-shortcut.js';
import { buildMacroDroidExport } from '../mobile/files/macrodroid.js';
import type { Exec } from '../mobile/files/sign.js';
import { signShortcut } from '../mobile/files/sign.js';

export const PHONE_NAMESPACE = 'bridge.mobile';

/** kv rows written by bridge.mobile; doctor reads the same rows from another process. */
export const PHONE_KEYS = { devices: DEVICES_KEY, lastSeen: 'lastSeen' } as const;
const CONTENT_TYPE = 'application/octet-stream';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;

export interface PhoneAdminHandle {
  admin: MobileAdmin;
  apk: ApkLinks;
  install: InstallLinks;
  close(): Promise<void>;
}

/** The CLI and the daemon open the same database; the daemon notices writes made from another process. */
export function phoneStorePath(home: string): string {
  return join(home, 'data', 'ax-kit.db');
}

export function phoneFilesDir(home: string, nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error(`Invalid pairing nonce: ${nonce}`);
  return join(home, 'files', 'phone', nonce);
}

export function openPhoneAdmin(home: string, options: { clock?: Clock } = {}): PhoneAdminHandle {
  const store: Store = openSqliteStore(phoneStorePath(home));
  const clock = options.clock ?? systemClock;
  const kv = store.kv(PHONE_NAMESPACE);
  const admin = new MobileAdmin({ kv, clock });
  return { admin, apk: new ApkLinks(kv, clock), install: new InstallLinks(kv, clock), close: () => store.close() };
}

export interface PreparePhoneFilesInput {
  platform: MobilePlatform;
  assistantName: string;
  language: string;
  publicUrl: string;
  token: string;
  nonce: string;
  filesDir: string;
  exec: Exec;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
}

/** Everything the CLI resolves itself; the process runner and the file system are supplied by the caller. */
export type PreparePhoneFilesSpec = Omit<PreparePhoneFilesInput, 'exec' | 'writeFile' | 'mkdir'>;

export interface PreparePhoneFilesResult {
  files: PairingFile[];
  /** iOS signing failed, so the unsigned XML workflows are attached instead. */
  unsigned: boolean;
  warning?: string;
  /** `<ingest url>|<token>` for the generic iCloud-link templates; set only when signing failed. */
  connection?: string;
}

function ingestUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/m/v1/ingest`;
}

function safeName(name: string): string {
  const cleaned = [...name]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character !== '/' && character !== '\\' && character !== ':' && code >= 0x20;
    })
    .join('')
    .trim();
  return cleaned.length > 0 ? cleaned : 'ax-kit';
}

function asFile(name: string, path: string): PairingFile {
  return { name, path, contentType: CONTENT_TYPE };
}

async function prepareAndroid(input: PreparePhoneFilesInput): Promise<PreparePhoneFilesResult> {
  const name = `${safeName(input.assistantName)}.macro`;
  const path = join(input.filesDir, name);
  const document = buildMacroDroidExport({
    assistantName: input.assistantName,
    url: ingestUrl(input.publicUrl),
    token: input.token,
    language: input.language,
  });
  await input.writeFile(path, document, FILE_MODE);
  return { files: [asFile(name, path)], unsigned: false };
}

async function prepareIos(input: PreparePhoneFilesInput): Promise<PreparePhoneFilesResult> {
  const shortcuts = buildIosShortcuts({
    assistantName: input.assistantName,
    url: ingestUrl(input.publicUrl),
    token: input.token,
    language: input.language,
  });
  const pending = shortcuts.map((shortcut) => {
    const base = shortcut.fileName.replace(/\.shortcut$/, '');
    return {
      name: shortcut.fileName,
      xmlPath: join(input.filesDir, `${base}.xml`),
      binPath: join(input.filesDir, `${base}.bin.shortcut`),
      signedPath: join(input.filesDir, shortcut.fileName),
      plistXml: shortcut.plistXml,
    };
  });
  for (const entry of pending) await input.writeFile(entry.xmlPath, entry.plistXml, FILE_MODE);

  for (const entry of pending) {
    try {
      await signShortcut({
        exec: input.exec,
        xmlPath: entry.xmlPath,
        binPath: entry.binPath,
        signedPath: entry.signedPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        files: pending.map((unsigned) => asFile(unsigned.name, unsigned.xmlPath)),
        unsigned: true,
        warning: message,
        connection: connectionString(ingestUrl(input.publicUrl), input.token),
      };
    }
  }
  return { files: pending.map((entry) => asFile(entry.name, entry.signedPath)), unsigned: false };
}

/** Writes and, for iOS, signs the phone-side import files for one pairing. */
export async function preparePhoneFiles(input: PreparePhoneFilesInput): Promise<PreparePhoneFilesResult> {
  await input.mkdir(input.filesDir, DIRECTORY_MODE);
  if (input.platform === 'android') return await prepareAndroid(input);
  return await prepareIos(input);
}
