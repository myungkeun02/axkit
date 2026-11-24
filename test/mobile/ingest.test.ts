import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import type { LlmRequest } from '../../src/core/llm/types.js';
import type { MobileDevice } from '../../src/mobile/devices.js';
import { MobileIngest } from '../../src/mobile/ingest.js';
import { mobileTexts } from '../../src/mobile/locale.js';
import { OtpVault } from '../../src/mobile/otp.js';
import { SampleStore } from '../../src/mobile/samples.js';
import { SmsActions } from '../../src/mobile/sms-action.js';
import type { IngestItem } from '../../src/mobile/schema.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';
import { ScriptedLlm } from '../support/context.js';
import { NOW, seededRandom } from './helpers.js';

const device: MobileDevice = {
  id: 'd_TESTTEST',
  name: 'phone',
  platform: 'ios',
  tokenHash: 'hash',
  createdAt: NOW.toISOString(),
  rotatedAt: NOW.toISOString(),
  failures: 0,
};

function make(script: (string | ((request: LlmRequest) => string))[] = []) {
  const clock = new FakeClock(NOW);
  const kv = new MapKeyValueStore();
  const samples = new SampleStore(kv, clock, 'Asia/Seoul');
  const otp = new OtpVault(clock);
  const bus = new InMemoryEventBus(silentLogger);
  const sms = new SmsActions({
    kv,
    llm: new ScriptedLlm(script),
    clock,
    log: silentLogger,
    texts: mobileTexts('ko'),
    notifier: () => undefined,
    todo: () => undefined,
    randomBytes: seededRandom(9),
  });
  const ingest = new MobileIngest({ samples, otp, sms, bus, log: silentLogger });
  return { clock, kv, samples, otp, bus, ingest };
}

describe('ingest fan-out', () => {
  it('stores signals and emits location and voice memo events', async () => {
    const { ingest, bus, samples } = make();
    const locations: { deviceId: string; location: { lat: number; lng: number; at: Date } }[] = [];
    const voices: { deviceId: string; text: string; at: Date }[] = [];
    bus.on('phone.location', (payload) => {
      locations.push(payload);
    });
    bus.on('phone.voice_memo', (payload) => {
      voices.push(payload);
    });
    const items: IngestItem[] = [
      { kind: 'location', at: NOW, lat: 37.5, lng: 127, label: 'example' },
      { kind: 'voice_memo', at: NOW, text: '우유 사기' },
    ];

    expect(await ingest.handle(device, NOW, items)).toBe(2);

    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ deviceId: device.id, location: { lat: 37.5, lng: 127 } });
    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({ deviceId: device.id, text: '우유 사기' });
    expect(await samples.latestLocation(10)).toMatchObject({ lat: 37.5 });
  });

  it('does not emit a voice memo for blank text', async () => {
    const { ingest, bus } = make();
    const voices: unknown[] = [];
    bus.on('phone.voice_memo', (payload) => {
      voices.push(payload);
    });

    await ingest.handle(device, NOW, [{ kind: 'voice_memo', at: NOW, text: '   ' }]);

    expect(voices).toHaveLength(0);
  });

  it('records one-time codes from SMS and app notifications without emitting them', async () => {
    const first = make();
    const locations: unknown[] = [];
    first.bus.on('phone.location', (payload) => {
      locations.push(payload);
    });
    await first.ingest.handle(device, NOW, [
      { kind: 'sms', at: NOW, from: 'example', text: '[Web발신] 인증번호 482913 입니다' },
    ]);
    expect(first.otp.latest()?.code).toBe('482913');
    expect(locations).toHaveLength(0);

    const second = make();
    await second.ingest.handle(device, NOW, [
      { kind: 'notification', at: NOW, app: '메일', text: 'Your verification code is 123456' },
    ]);
    expect(second.otp.latest()?.code).toBe('123456');
  });

  it('keeps ingesting when the action check fails', async () => {
    const { ingest, samples } = make();
    const items: IngestItem[] = [
      { kind: 'sms', at: NOW, from: 'example', text: '내일까지 회비를 보내 주세요' },
    ];

    await expect(ingest.handle(device, NOW, items)).resolves.toBe(1);
    expect(await samples.lastSeen()).toEqual(NOW);
  });
});
