import type { Plugin } from '../../core/plugin/types.js';
import { registerClose } from './close.js';
import { healthSettings, readDayConfig } from './config.js';
import { registerHealth } from './health.js';
import { registerNudges } from './nudges.js';
import { dayTexts } from './locale.js';
import { registerPrep } from './prep.js';
import { registerReplies } from './replies.js';
import { registerTravel } from './travel.js';
import { registerMeetLinks } from './meet-reminder.js';
import { registerVoice } from './voice.js';

/**
 * Day-flow skill: the evening prep, travel-time warning, day close, awaiting-reply digest, voice memos and health
 * reminders. Every external source is optional and resolved on each run.
 */
export function daySkill(): Plugin {
  return {
    manifest: {
      id: 'skill.day',
      kind: 'skill',
      title: 'Day flow',
    },
    setup(ctx) {
      const config = readDayConfig(ctx);
      const texts = dayTexts(ctx.assistant.language);

      if (config.prep) registerPrep(ctx, config.prepAt, texts, config.situational);
      if (config.travel) registerTravel(ctx, config.travelBufferMinutes, texts);
      if (config.meetLinks) registerMeetLinks(ctx);
      if (config.close) registerClose(ctx, config.closeAt, texts, config.situational);
      if (config.replies) registerReplies(ctx, config.repliesAt, texts);
      if (config.voice) registerVoice(ctx, texts);
      registerNudges(ctx, config.nudges, texts);

      const health = healthSettings(config);
      if (health !== undefined) registerHealth(ctx, health, texts);
    },
  };
}
