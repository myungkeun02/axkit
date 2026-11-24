import type { MobileDevice } from '../mobile/index.js';
import type { PhoneCliDeps } from './phone.js';

function formatAge(from: Date, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function formatDevice(device: MobileDevice, now: Date): string {
  const status = device.revokedAt !== undefined ? '해제됨' : '연결됨';
  const seen =
    device.lastSeenAt === undefined ? '신호 없음' : `마지막 신호 ${formatAge(new Date(device.lastSeenAt), now)}`;
  const kind = device.client === 'app' ? ', 앱' : '';
  return `- ${device.id}  ${device.name} (${device.platform}${kind}, ${status})  ${seen}`;
}

/** `phone list`: every paired phone and app with its last signal. */
export async function listCommand(deps: PhoneCliDeps): Promise<number> {
  const handle = deps.openAdmin(deps.home);
  try {
    const devices = await handle.admin.list();
    if (devices.length === 0) {
      deps.say('등록된 휴대폰이 없어요. `ax-kit phone pair`로 연결해 주세요.');
      return 0;
    }
    const now = deps.now?.() ?? new Date();
    for (const device of devices) deps.say(formatDevice(device, now));
  } finally {
    await handle.close();
  }
  return 0;
}
