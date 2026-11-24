import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { remoteInstall } from '../../src/cli/remote-install.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { MobileAdmin } from '../../src/mobile/admin.js';
import { ApkLinks } from '../../src/mobile/apk-links.js';
import { InstallLinks, installCommand } from '../../src/mobile/install-links.js';
import { reportRoute, sourceScript } from '../../src/mobile/install-source.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';

const NOW = new Date('2026-11-24T18:00:00+09:00');

function post(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' }, method: 'POST' }) as unknown as IncomingMessage;
}
function capture(): { response: ServerResponse; status: () => number } {
  let code = 0;
  const response = { statusCode: 0, setHeader: () => undefined, writeHead: (status: number) => ((code = status), response), end: () => undefined } as unknown as ServerResponse;
  return { response, status: () => code || (response as unknown as { statusCode: number }).statusCode };
}

describe('reading files on another Mac without cloning anything there', () => {
  it('the script installs the handed-out copy, asks for folders on that Mac and reports back', async () => {
    const links = new InstallLinks(new MapKeyValueStore(), new FakeClock(NOW));
    const link = await links.create({ zip: '/x.tar.gz', base: 'https://mini.ts.net:8443', pair: '', kind: 'source', ttlMs: 30 * 60_000 });
    const script = sourceScript(link);
    expect(script).toContain(`curl -fsSL "$BASE/m/install/$N/ax-kit.tar.gz" | tar -xz -C "$DIR"`);
    expect(script).toContain('AX_KIT_DIR="$DIR" AX_KIT_NO_SETUP=1 bash "$DIR/install.sh"');
    expect(script).toContain('node "$AX" source pair "$BASE/m/install/$N/paired"');
    expect(script).not.toContain('git clone');
    expect(installCommand(link)).toBe(`bash -c "$(curl -fsSL https://mini.ts.net:8443/m/install/${link.nonce})"`);
  });

  it('takes one well-formed report on the tailnet, refuses anything else', async () => {
    const links = new InstallLinks(new MapKeyValueStore(), new FakeClock(NOW));
    const link = await links.create({ zip: '/x', base: 'https://mini.ts.net', pair: '', kind: 'source' });
    const path = `/m/install/${link.nonce}/paired`;
    const bad = capture();
    await reportRoute(links, path, post({ url: 'http://evil.example.com:80', code: 'ABCD-EFGH' }), bad.response);
    expect((await links.find(link.nonce))?.reported).toBeUndefined();
    await reportRoute(links, path, post({ url: 'http://100.64.0.7:47720', code: 'abcd-efgh' }), capture().response);
    expect((await links.find(link.nonce))?.reported).toEqual({ url: 'http://100.64.0.7:47720', code: 'ABCD-EFGH' });
    expect(await links.report(link.nonce, { url: 'http://100.64.0.8:1', code: 'ZZZZ-ZZZZ' })).toBe(false);
  });

  it('remote install waits for the report and pairs by itself', async () => {
    const kv = new MapKeyValueStore();
    const clock = new FakeClock(NOW);
    const install = new InstallLinks(kv, clock);
    const said: string[] = [];
    const prompter = createScriptedPrompter(['']);
    prompter.say = (line: string) => void said.push(line);
    let waited = 0;
    const exchanged: { url: string; code: string }[] = [];
    const code = await remoteInstall({
      remote: { prompter, secrets: new MemorySecretStore(), file: `/tmp/axk-remotes-${process.pid}-${Date.now()}.json`, now: () => NOW, thisMac: 'mini', post: (async (url: string, _route: string, body: unknown) => (exchanged.push({ url, code: String((body as { code?: string }).code) }), url.includes('100.64') && String(_route).includes('pair') ? { token: 't'.repeat(32), host: 'work-macbook' } : { folders: [], sessions: 0 })) as never } as never,
      home: '/h',
      tarball: '/h/dist/ax-kit-source.tar.gz',
      publicUrl: async () => 'https://mini.ts.net:8443',
      openAdmin: () => ({ admin: new MobileAdmin({ kv, clock }), apk: new ApkLinks(kv, clock), install, close: async () => {} }),
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      sleep: async () => {
        waited += 1;
        const [link] = (await kv.get<{ nonce: string }[]>('installLinks')) ?? [];
        if (link !== undefined) await install.report(link.nonce, { url: 'http://100.64.0.7:47720', code: 'ABCD-EFGH' });
      },
    });
    expect(said.join('\n')).toContain('bash -c "$(curl -fsSL https://mini.ts.net:8443/m/install/');
    expect(waited).toBe(1);
    expect(said.join('\n')).toContain('연결을 마무리할게요');
    expect(code).toBe(0);
    expect(exchanged[0]).toEqual({ url: 'http://100.64.0.7:47720', code: 'ABCD-EFGH' });
  });
});
