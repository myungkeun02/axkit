import { describe, expect, it } from 'vitest';
import { screenChatChecks } from '../../../src/connectors/screen-chat/checks.js';
import { FakeAxReader } from './helpers.js';

const FIX =
  'System Settings > Privacy & Security > Accessibility: allow the app that runs ax-kit (Terminal or node), then restart ax-kit';

describe('screenChatChecks', () => {
  it('checks accessibility and both app bundles without reading the screen', async () => {
    const reader = new FakeAxReader();
    reader.trustedValue = true;
    const paths: string[] = [];

    const checks = await screenChatChecks({
      reader,
      appExists: async (path) => {
        paths.push(path);
        return true;
      },
      kakao: true,
      discord: true,
    });

    expect(checks).toEqual([
      { id: 'screen.accessibility', ok: true, detail: 'Accessibility access is allowed.' },
      { id: 'screen.kakao-app', ok: true, detail: 'KakaoTalk is installed at /Applications/KakaoTalk.app.' },
      { id: 'screen.discord-app', ok: true, detail: 'Discord is installed at /Applications/Discord.app.' },
    ]);
    expect(paths).toEqual(['/Applications/KakaoTalk.app', '/Applications/Discord.app']);
    expect(reader.dumpCalls).toHaveLength(0);
  });

  it('reports the accessibility fix when permission is missing', async () => {
    const reader = new FakeAxReader();
    reader.trustedValue = false;

    const [check] = await screenChatChecks({
      reader,
      appExists: async () => true,
      kakao: false,
      discord: false,
    });

    expect(check).toEqual({
      id: 'screen.accessibility',
      ok: false,
      detail: 'Accessibility access is not allowed.',
      fix: FIX,
    });
  });

  it('reports a helper build failure with its message', async () => {
    const reader = new FakeAxReader();
    reader.failure = new Error('swiftc could not build ax-read: no SDK');

    const [check] = await screenChatChecks({
      reader,
      appExists: async () => true,
      kakao: false,
      discord: false,
    });

    expect(check?.ok).toBe(false);
    expect(check?.detail).toBe('swiftc could not build ax-read: no SDK');
    expect(check?.fix).toBe(FIX);
    expect(reader.dumpCalls).toHaveLength(0);
  });

  it('checks only the apps that are enabled', async () => {
    const reader = new FakeAxReader();
    reader.trustedValue = true;
    const paths: string[] = [];

    const checks = await screenChatChecks({
      reader,
      appExists: async (path) => {
        paths.push(path);
        return path === '/Applications/KakaoTalk.app';
      },
      kakao: true,
      discord: false,
    });

    expect(checks.map((check) => check.id)).toEqual(['screen.accessibility', 'screen.kakao-app']);
    expect(checks[1]?.ok).toBe(true);
    expect(paths).toEqual(['/Applications/KakaoTalk.app']);
  });

  it('suggests installing a missing app', async () => {
    const reader = new FakeAxReader();
    reader.trustedValue = true;

    const checks = await screenChatChecks({
      reader,
      appExists: async () => false,
      kakao: false,
      discord: true,
    });

    expect(checks[1]).toEqual({
      id: 'screen.discord-app',
      ok: false,
      detail: '/Applications/Discord.app was not found.',
      fix: 'Install Discord for Mac from discord.com/download.',
    });
  });
});
