import { dirname, join } from 'node:path';

export interface LaunchAgentOptions {
  label: string;
  nodePath: string;
  entry: string;
  home: string;
  logDir: string;
  /** More folders for PATH, before the system ones. */
  extraPath?: readonly string[];
  /** What to run after the entry; default `start --home <home>`. */
  args?: readonly string[];
  /** Log file stem; default "ax-kit" (ax-kit.out.log / ax-kit.err.log). */
  logName?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderLaunchAgent(opts: LaunchAgentOptions): string {
  const label = escapeXml(opts.label);
  const nodePath = escapeXml(opts.nodePath);
  const entry = escapeXml(opts.entry);
  const home = escapeXml(opts.home);
  const logName = opts.logName ?? 'ax-kit';
  const stdout = escapeXml(join(opts.logDir, `${logName}.out.log`));
  const stderr = escapeXml(join(opts.logDir, `${logName}.err.log`));
  const args = (opts.args ?? ['start', '--home', opts.home]).map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  // `security` (Keychain) lives in /usr/bin, and launchd starts with a minimal PATH.
  // Also the owner's own tool folders (Homebrew, ~/.local/bin for claude, npm globals), so CLIs the assistant uses
  // (claude, codex, aside, git) are found the same as in their terminal.
  const dirs = [dirname(opts.nodePath), ...(opts.extraPath ?? []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const path = escapeXml([...new Set(dirs.filter((dir) => dir.startsWith('/')))].join(':'));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entry}</string>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${stdout}</string>
  <key>StandardErrorPath</key>
  <string>${stderr}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path}</string>
    <key>AX_KIT_HOME</key>
    <string>${home}</string>
  </dict>
</dict>
</plist>
`;
}
