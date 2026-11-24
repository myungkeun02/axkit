import type { Notice, Notifier, PhoneDayTotals } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { MessageHandler } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { HealthSettings, MedSettings } from './config.js';
import { minutesOfDay, minutesOfTime, todayDay, ymdPlus } from './day-range.js';
import type { DayTexts } from './locale.js';

export const HEALTH_JOB = 'day.health';
export const HEALTH_SNOOZE_JOB = 'day.health.snooze';
const SWEEP_SECONDS = 1_800;
const SNOOZE_SECONDS = 60;
const SNOOZE_MS = 10 * 60_000;
const STEP_KEY = 'health.steps';
const WATER_KEY = 'health.water.last';
const MED_KEY = 'health.meds';
const KEEP_DAYS = 7;
const STEP_SLOTS: readonly { hhmm: string; ratio: number }[] = [
  { hhmm: '15:00', ratio: 0.4 },
  { hhmm: '19:00', ratio: 0.75 },
];

type MedState = 'sent' | 'done' | { snoozeAt: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prune(states: Record<string, unknown>, today: string): Record<string, unknown> {
  const oldest = ymdPlus(today, -KEEP_DAYS);
  return Object.fromEntries(
    Object.entries(states).filter(([key]) => {
      const ymd = key.slice(0, 10);
      return ymd >= oldest;
    }),
  );
}

async function readStates<T>(ctx: PluginContext, key: string): Promise<Record<string, T>> {
  return (await ctx.kv.get<Record<string, T>>(key)) ?? {};
}

async function notify(ctx: PluginContext, notice: Notice): Promise<boolean> {
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('day health: no notifier available');
    return false;
  }
  await notifier.notify(notice);
  return true;
}

async function checkSteps(ctx: PluginContext, health: HealthSettings, texts: DayTexts, now: Date): Promise<void> {
  const phone = ctx.tryUse(Contracts.phoneSignals);
  if (phone === undefined) return;
  const minutes = minutesOfDay(now, ctx.assistant.timezone);

  let slotIndex = -1;
  for (const [index, slot] of STEP_SLOTS.entries()) {
    const slotMinutes = minutesOfTime(slot.hhmm);
    if (slotMinutes !== undefined && minutes >= slotMinutes) slotIndex = index;
  }
  if (slotIndex < 0) return;

  const day = todayDay(now, ctx.assistant.timezone);
  const key = `${day.ymd}:${slotIndex}`;
  const states = await readStates<boolean>(ctx, STEP_KEY);
  if (states[key] === true) return;

  let totals: PhoneDayTotals;
  try {
    totals = await phone.dayTotals(day.ymd);
  } catch (error) {
    ctx.log.warn('day health: phone totals could not be read', { error: messageOf(error) });
    return;
  }
  if (totals.steps === undefined) return;

  const slot = STEP_SLOTS[slotIndex];
  if (slot !== undefined && totals.steps < health.stepGoal * slot.ratio) {
    const sent = await notify(ctx, {
      kind: 'day.health.steps',
      dedupeKey: `${day.ymd}:steps:${slotIndex}`,
      text: texts.stepsNudge(totals.steps, health.stepGoal),
    });
    if (!sent) return;
  }
  states[key] = true;
  await ctx.kv.set(STEP_KEY, prune(states, day.ymd));
}

async function checkWater(ctx: PluginContext, health: HealthSettings, texts: DayTexts, now: Date): Promise<void> {
  const water = health.water;
  if (water === false) return;
  const minutes = minutesOfDay(now, ctx.assistant.timezone);
  const from = minutesOfTime(water.from);
  const to = minutesOfTime(water.to);
  if (from === undefined || to === undefined || minutes < from || minutes >= to) return;

  const last = await ctx.kv.get<string>(WATER_KEY);
  if (last !== undefined) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < water.everyMinutes * 60_000) return;
  }
  const day = todayDay(now, ctx.assistant.timezone);
  const sent = await notify(ctx, {
    kind: 'day.health.water',
    dedupeKey: `${day.ymd}:water:${Math.floor(minutes / water.everyMinutes)}`,
    text: texts.waterNudge,
  });
  if (sent) await ctx.kv.set(WATER_KEY, now.toISOString());
}

function medChoices(index: number, ymd: string, texts: DayTexts) {
  return [
    { id: `day.med_done:${index}:${ymd}`, label: texts.medDoneLabel },
    { id: `day.med_snooze:${index}:${ymd}`, label: texts.medSnoozeLabel },
  ];
}

async function sendMed(
  notifier: Notifier,
  med: MedSettings,
  index: number,
  ymd: string,
  texts: DayTexts,
): Promise<void> {
  await notifier.notify({
    kind: 'day.health.med',
    urgent: true,
    dedupeKey: `med:${ymd}:${index}`,
    text: texts.medReminder(med.name),
    choices: medChoices(index, ymd, texts),
  });
}

async function checkMeds(ctx: PluginContext, health: HealthSettings, texts: DayTexts, now: Date): Promise<void> {
  if (health.meds.length === 0) return;
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('day health: no notifier available');
    return;
  }
  const minutes = minutesOfDay(now, ctx.assistant.timezone);
  const day = todayDay(now, ctx.assistant.timezone);
  const states = await readStates<MedState>(ctx, MED_KEY);
  let changed = false;
  for (const [index, med] of health.meds.entries()) {
    const at = minutesOfTime(med.at);
    const key = `${day.ymd}:${index}`;
    if (at === undefined || minutes < at || states[key] !== undefined) continue;
    try {
      await sendMed(notifier, med, index, day.ymd, texts);
      states[key] = 'sent';
      changed = true;
    } catch (error) {
      ctx.log.warn('day health: medicine reminder failed', { error: messageOf(error) });
    }
  }
  if (changed) await ctx.kv.set(MED_KEY, prune(states, day.ymd));
}

async function resendSnoozed(ctx: PluginContext, health: HealthSettings, texts: DayTexts, now: Date): Promise<void> {
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) return;
  const states = await readStates<MedState>(ctx, MED_KEY);
  let changed = false;
  for (const [key, state] of Object.entries(states)) {
    if (typeof state !== 'object' || state === null) continue;
    if (Date.parse(state.snoozeAt) > now.getTime()) continue;
    const [ymd = '', indexText = ''] = key.split(':');
    const index = Number(indexText);
    const med = health.meds[index];
    if (med === undefined) {
      states[key] = 'done';
      changed = true;
      continue;
    }
    try {
      await sendMed(notifier, med, index, ymd, texts);
      states[key] = 'sent';
      changed = true;
    } catch (error) {
      ctx.log.warn('day health: snoozed reminder failed', { error: messageOf(error) });
    }
  }
  if (changed) await ctx.kv.set(MED_KEY, states);
}

function medHandler(ctx: PluginContext, health: HealthSettings, texts: DayTexts): MessageHandler {
  return {
    id: 'day.health.meds',
    priority: 72,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const match = /^\(choice: day\.med_(done|snooze):(\d+):(\d{4}-\d{2}-\d{2})\)$/.exec(message.text.trim());
      if (match === null) return 'pass';
      const action = match[1];
      const index = Number(match[2]);
      const ymd = match[3] ?? '';
      const med = health.meds[index];
      if (action === undefined || med === undefined) return 'pass';

      const states = await readStates<MedState>(ctx, MED_KEY);
      const key = `${ymd}:${index}`;
      if (action === 'done') {
        states[key] = 'done';
        await ctx.kv.set(MED_KEY, states);
        return 'handled';
      }
      states[key] = { snoozeAt: new Date(ctx.clock.now().getTime() + SNOOZE_MS).toISOString() };
      await ctx.kv.set(MED_KEY, states);
      await replier.reply(message.conversation, { text: texts.medSnoozeAck });
      return 'handled';
    },
  };
}

/** Registers the half-hourly health sweep, the snooze sweep and the owner-only medicine buttons. */
export function registerHealth(ctx: PluginContext, health: HealthSettings, texts: DayTexts): void {
  ctx.scheduler.add({
    name: HEALTH_JOB,
    schedule: { kind: 'every', seconds: SWEEP_SECONDS },
    async run(now) {
      for (const check of [checkSteps, checkWater, checkMeds]) {
        try {
          await check(ctx, health, texts, now);
        } catch (error) {
          ctx.log.warn('day health: sweep step failed', { error: messageOf(error) });
        }
      }
    },
  });

  if (health.meds.length === 0) return;
  ctx.scheduler.add({
    name: HEALTH_SNOOZE_JOB,
    schedule: { kind: 'every', seconds: SNOOZE_SECONDS },
    run: (now) => resendSnoozed(ctx, health, texts, now),
  });
  ctx.registerHandler(medHandler(ctx, health, texts));
}
