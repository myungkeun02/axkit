import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Java is on this Mac: JAVA_HOME, Homebrew's openjdk@17 (not on PATH by design), Android Studio's own, or what
 * macOS finds. Undefined when there is none (keytool and Gradle need it).
 */
export function findJavaHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env['JAVA_HOME'],
    '/opt/homebrew/opt/openjdk@17',
    '/usr/local/opt/openjdk@17',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/homebrew/opt/openjdk',
    '/usr/local/opt/openjdk',
  ];
  return candidates.find((dir): dir is string => dir !== undefined && dir !== '' && existsSync(join(dir, 'bin', 'keytool')));
}

/** The Android SDK: ANDROID_HOME, Android Studio's, or Homebrew's command-line tools. */
export function findAndroidSdk(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env['ANDROID_HOME'], join(homedir(), 'Library', 'Android', 'sdk'), '/opt/homebrew/share/android-commandlinetools', '/usr/local/share/android-commandlinetools'];
  return candidates.find((dir): dir is string => dir !== undefined && dir !== '' && existsSync(join(dir, 'platforms')));
}

