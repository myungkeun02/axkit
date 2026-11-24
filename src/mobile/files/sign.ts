export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected process runner. Real callers reject only when the binary cannot be spawned. */
export type Exec = (cmd: string, args: ReadonlyArray<string>) => Promise<ExecResult>;

export interface SignShortcutOptions {
  exec: Exec;
  xmlPath: string;
  binPath: string;
  signedPath: string;
}

const ICLOUD_HINT =
  'Signing needs this Mac to be online and signed in to iCloud. Without it, use the iCloud link route: ' +
  'share the unsigned shortcut and answer the import questions with the pairing string.';

function failure(tool: string, result: ExecResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || 'no output';
  return new Error(`${tool} failed (exit ${result.code}): ${detail}. ${ICLOUD_HINT}`);
}

/** Converts the XML plist to binary and signs it so iOS imports it without the "untrusted shortcut" warning. */
export async function signShortcut(options: SignShortcutOptions): Promise<void> {
  // Checked on macOS 27: `shortcuts sign` rejects a valid binary plist unless its file name ends in ".shortcut".
  if (!options.binPath.endsWith('.shortcut')) {
    throw new Error(`binPath must end with .shortcut: ${options.binPath}`);
  }
  const converted = await options.exec('plutil', [
    '-convert',
    'binary1',
    '-o',
    options.binPath,
    options.xmlPath,
  ]);
  if (converted.code !== 0) throw failure('plutil', converted);

  const signed = await options.exec('shortcuts', [
    'sign',
    '--mode',
    'anyone',
    '--input',
    options.binPath,
    '--output',
    options.signedPath,
  ]);
  if (signed.code !== 0) throw failure('shortcuts sign', signed);
}

/** True when the macOS `shortcuts` command can be spawned. */
export async function shortcutsAvailable(exec: Exec): Promise<boolean> {
  try {
    const result = await exec('shortcuts', ['--help']);
    return result.code === 0;
  } catch {
    return false;
  }
}
