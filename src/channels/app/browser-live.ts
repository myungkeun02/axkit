import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppView, DeviceApi, DeviceEventStream } from '../../core/contracts/device-api.js';
import { ViewInputError, ownerInputError } from '../../core/contracts/device-api.js';
import { LIVE_KEYS } from '../../core/contracts/index.js';
import type { BrowserLiveHub, LiveFrame, LiveInput } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { DONE_EN, DONE_KO, postContinue } from './browser-live-done.js';
import type { AppEventLog } from './log.js';

export const LIVE_VIEW_NAME = 'browser-live';
export const LIVE_FRAME_PATH = 'browser-live/frame';
export const LIVE_STREAM_PATH = 'browser-live/stream';
/** How often an open stream looks for a new picture; a frame is sent only when the page changed. */
export const LIVE_TICK_MS = 700;
/** Phone and desktop watching at once share one screenshot. */
const FRAME_REUSE_MS = 400;

const empty = z.object({}).passthrough();
const tapSchema = z.object({ x: z.number().finite().min(0).max(20_000), y: z.number().finite().min(0).max(20_000) });
const typeSchema = z.object({ text: z.string().min(1).max(1000) });
const keySchema = z.object({ name: z.enum(LIVE_KEYS) });
const scrollSchema = z.object({ dy: z.number().finite().min(-20_000).max(20_000) });

interface LiveTexts {
  closed: string;
  nothing: string;
  busy: string;
}

const KO: LiveTexts = {
  closed: '브라우저 화면이 닫혀 있어요. 비서에게 다시 열어 달라고 해 주세요.',
  nothing: '지금 열어 드릴 브라우저 화면이 없어요.',
  busy: '브라우저가 다른 일을 하는 중이라 지금은 열 수 없어요. 잠시 뒤 다시 해 주세요.',
};

const EN: LiveTexts = {
  closed: 'The browser screen is closed. Ask the assistant to open it again.',
  nothing: 'There is no browser page to open right now.',
  busy: 'The browser is busy with something else. Try again in a moment.',
};

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new ViewInputError('shape');
  return parsed.data;
}

/** One screenshot shared by every watcher for a moment, so two screens never double the work on the Mac. */
class FrameCache {
  private last: { at: number; frame: Promise<LiveFrame | undefined> } | undefined;

  constructor(
    private readonly hub: BrowserLiveHub,
    private readonly now: () => number,
  ) {
    // a page that opened or closed never shows the previous page's picture
    hub.subscribe(() => {
      this.last = undefined;
    });
  }

  get(): Promise<LiveFrame | undefined> {
    if (!this.hub.state().live) return Promise.resolve(undefined);
    const at = this.now();
    if (this.last !== undefined && at - this.last.at < FRAME_REUSE_MS) return this.last.frame;
    const frame = this.hub.frame();
    this.last = { at, frame };
    return frame;
  }
}

export interface BrowserLiveDeps {
  ctx: PluginContext;
  api: DeviceApi;
  log: AppEventLog;
  hub: BrowserLiveHub;
}

/**
 * §22: the owner takes over a browser page a handoff left (login, captcha, consent, a last button) from the app.
 * Only the owner's paired app reaches these routes; typed text goes straight to the page and is never logged, put in
 * the chat log, or shown to the assistant. "Done" closes the page and tells the assistant to carry on.
 */
export function browserLiveView(deps: BrowserLiveDeps): AppView {
  const { ctx, hub } = deps;
  const texts = ctx.assistant.language === 'en' ? EN : KO;
  const state = (): Record<string, unknown> => ({ ...hub.state(), frameUrl: LIVE_FRAME_PATH, streamUrl: LIVE_STREAM_PATH });
  const send = async (action: LiveInput): Promise<Record<string, unknown>> => {
    const result = await hub.input(action);
    if (result === 'not_live') throw ownerInputError(texts.closed);
    return result === 'too_fast' ? { accepted: false, retryAfterMs: 250 } : { accepted: true };
  };
  return {
    name: LIVE_VIEW_NAME,
    version: 1,
    read: async () => state(),
    actions: {
      start: async (body) => {
        parse(empty, body);
        const before = hub.state();
        if (!before.live && before.pending === undefined) throw ownerInputError(texts.nothing);
        if (!(await hub.start())) throw ownerInputError(texts.busy);
        return state();
      },
      tap: async (body) => {
        const { x, y } = parse(tapSchema, body);
        return await send({ kind: 'tap', x, y });
      },
      type: async (body) => await send({ kind: 'type', text: parse(typeSchema, body).text }),
      key: async (body) => await send({ kind: 'key', key: parse(keySchema, body).name }),
      scroll: async (body) => await send({ kind: 'scroll', dy: parse(scrollSchema, body).dy }),
      back: async (body) => {
        parse(empty, body);
        return await send({ kind: 'back' });
      },
      done: async (body) => {
        parse(empty, body);
        const before = hub.state();
        const had = before.live || before.pending !== undefined;
        const { host, origin } = await hub.finish();
        if (had) {
          // the owner's own "carry on", in the conversation the errand came from, handed to the assistant like a typed line
          const where = await postContinue({ ctx, log: deps.log, texts: ctx.assistant.language === 'en' ? DONE_EN : DONE_KO }, origin, host);
          return { ...state(), resumed: true, ...where };
        }
        return { ...state(), resumed: false };
      },
    },
  };
}

/** The picture routes: one JPEG on demand, and a stream that pushes a new one whenever the page changes. */
export function registerBrowserLiveRoutes(deps: BrowserLiveDeps): void {
  const { ctx, api, hub } = deps;
  const frames = new FrameCache(hub, () => ctx.clock.now().getTime());
  api.download(LIVE_FRAME_PATH, async () => {
    const frame = await frames.get();
    return frame === undefined ? undefined : { bytes: frame.jpeg, contentType: 'image/jpeg', name: 'browser.jpg' };
  });
  api.stream(LIVE_STREAM_PATH, (_caller, stream) => {
    openFrameStream(ctx, hub, frames, stream);
  });
}

function openFrameStream(ctx: PluginContext, hub: BrowserLiveHub, frames: FrameCache, stream: DeviceEventStream): void {
  let closed = false;
  let busy = false;
  let lastHash = '';
  let seq = 0;
  let timer: unknown;
  const tick = async (): Promise<void> => {
    if (closed || busy) return;
    busy = true;
    try {
      if (!hub.state().live) return;
      const frame = await frames.get();
      if (frame === undefined || closed) return;
      const hash = createHash('sha256').update(frame.jpeg).digest('hex');
      if (hash === lastHash) return;
      lastHash = hash;
      seq += 1;
      stream.send('frame', {
        seq,
        url: frame.url,
        title: frame.title,
        width: frame.width,
        height: frame.height,
        jpeg: frame.jpeg.toString('base64'),
      });
    } catch {
      // the next tick tries again; a closed page reports itself through `state`
    } finally {
      busy = false;
    }
  };
  const arm = (): void => {
    if (closed) return;
    timer = ctx.clock.setTimeout(() => {
      void tick().finally(arm);
    }, LIVE_TICK_MS);
  };
  const unsubscribe = hub.subscribe((state) => {
    if (closed) return;
    if (!state.live) lastHash = '';
    stream.send('state', state);
  });
  stream.onClose(() => {
    closed = true;
    unsubscribe();
    if (timer !== undefined) ctx.clock.clearTimeout(timer);
  });
  stream.send('state', hub.state());
  void tick().finally(arm);
}
