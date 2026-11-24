import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { androidPackages, setupAppDev } from '../../src/cli/setup-app-dev.js';

describe('setup: the assistant can improve its own apps on this Mac', () => {
  it('takes the Android SDK the app asks for', () => {
    expect(androidPackages('android {\n    compileSdk = 37\n')).toEqual(['platform-tools', 'platforms;android-37', 'build-tools;37.0.0']);
  });

  it('gets the app code and tools that are missing, skips what is there, and says what only a person can do', async () => {
    const ran: string[] = [];
    const have = new Set<string>();
    const said: string[] = [];
    const prompter = createScriptedPrompter(['2']);
    prompter.say = (line: string) => void said.push(line);
    const result = await setupAppDev({
      prompter,
      userHome: '/u',
      hasCommand: async (name) => name === 'brew',
      exists: async (path) => have.has(path) || path.endsWith('/.git') || path.endsWith('/platforms'),
      run: async (cmd, args) => {
        ran.push([cmd, ...args].join(' '));
        if (cmd === 'bash' && args[1]?.includes('rustup')) have.add('/u/.cargo/bin/cargo');
        return 0;
      },
      readFile: async () => 'compileSdk = 37',
      writeFile: async (path, text) => void ran.push(`write ${path} ${text.trim()}`),
    });
    expect(ran.some((line) => line.includes('sh.rustup.rs'))).toBe(true);
    expect(ran).toContain('brew install openjdk@17');
    expect(ran.some((line) => line.includes('"platforms;android-37"'))).toBe(true);
    expect(ran).toContain('write /u/ax-kit-apps/ax-kit-android/local.properties sdk.dir=/opt/homebrew/share/android-commandlinetools');
    // the repos were already there: nothing cloned
    expect(ran.some((line) => line.startsWith('git clone'))).toBe(false);
    expect(result.ready).toEqual(['맥 데스크톱 앱', '안드로이드 앱']);
    expect(result.missing.join('\n')).toContain('Xcode');
  });

  it('can be skipped', async () => {
    const result = await setupAppDev({ prompter: createScriptedPrompter(['']), userHome: '/u', hasCommand: async () => false, exists: async () => false, run: async () => 0, readFile: async () => '', writeFile: async () => undefined });
    expect(result.ready).toEqual([]);
  });
});
