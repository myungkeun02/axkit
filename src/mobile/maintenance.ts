import { Contracts } from '../core/contracts/index.js';
import type { PluginContext } from '../core/plugin/types.js';
import type { MobileAdmin } from './admin.js';
import type { MobileTexts } from './locale.js';

export const MAINTENANCE_JOB = 'mobile.maintenance';

const DAY_MS = 24 * 60 * 60_000;
const ROTATE_AFTER_DAYS = 90;
const REMIND_EVERY_DAYS = 30;

/** Drops expired tokens and pairings, then suggests a rotation for connections older than 90 days. */
export function registerMobileMaintenance(ctx: PluginContext, admin: MobileAdmin, texts: MobileTexts): void {
  ctx.scheduler.add({
    name: MAINTENANCE_JOB,
    schedule: { kind: 'daily', at: '09:30' },
    async run(now) {
      const pruned = await admin.prune(now);
      if (pruned.pairings > 0 || pruned.previous > 0) {
        ctx.log.debug('mobile: maintenance pruned expired records', pruned);
      }
      const notifier = ctx.tryUse(Contracts.notifier);
      for (const device of await admin.list()) {
        if (device.revokedAt !== undefined) continue;
        if (now.getTime() - Date.parse(device.rotatedAt) < ROTATE_AFTER_DAYS * DAY_MS) continue;
        const remindedAt = device.rotationRemindedAt === undefined ? undefined : Date.parse(device.rotationRemindedAt);
        if (remindedAt !== undefined && now.getTime() - remindedAt < REMIND_EVERY_DAYS * DAY_MS) continue;
        if (notifier === undefined) {
          ctx.log.warn('mobile: rotation reminder skipped because no notifier is available', {
            deviceId: device.id,
          });
          return;
        }
        await notifier.notify({
          kind: 'phone.rotate_reminder',
          dedupeKey: `phone.rotate:${device.id}`,
          text: texts.rotateReminder(device),
        });
        await admin.markRotationReminded(device.id, now);
      }
    },
  });
}
