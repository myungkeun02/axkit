import { describe, expect, it } from 'vitest';
import { renderLaunchAgent } from '../../src/cli/launchd.js';

describe('renderLaunchAgent', () => {
  it('renders a keep-alive agent and escapes XML', () => {
    const plist = renderLaunchAgent({
      label: 'com.example.ax&kit',
      nodePath: '/usr/local/bin/node',
      entry: '/Users/me/<ax-kit>/src/cli/main.ts',
      home: '/Users/me/ax&kit',
      logDir: '/Users/me/ax&kit/logs',
    });

    expect(plist).toContain('<string>com.example.ax&amp;kit</string>');
    expect(plist).toContain('/Users/me/&lt;ax-kit&gt;/src/cli/main.ts');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('<key>AX_KIT_HOME</key>');
    expect(plist).toContain('/Users/me/ax&amp;kit/logs/ax-kit.err.log');
    expect(plist).toContain('<string>--home</string>');
  });

  it('throttles restarts and puts node and /usr/bin on PATH', () => {
    const plist = renderLaunchAgent({
      label: 'io.axkit.assistant',
      nodePath: '/opt/node/bin/node',
      entry: '/opt/ax-kit/bin/ax-kit.mjs',
      home: '/Users/alex/.ax-kit',
      logDir: '/Users/alex/.ax-kit/logs',
    });

    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>30</integer>');
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('<string>/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>');
    expect(plist).not.toContain('ProcessType');
  });
});
