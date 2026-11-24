import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { GoogleCalendar } from './calendar.js';
import { GmailAttachments } from './gmail-attachments.js';
import { GmailComposer } from './gmail-compose.js';
import { GmailOrganizer } from './gmail-organize.js';
import { GoogleMail } from './gmail.js';
import { googleRequest } from './http.js';
import type { GoogleRequestFn } from './http.js';
import { GoogleTokenSource, OAUTH_CLIENT_SECRET, REFRESH_TOKEN_SECRET } from './token.js';

export interface GoogleConnectorOptions {
  /** Tests inject a fake; production uses global fetch. */
  fetch?: typeof fetch;
  /** Tests inject a fake; production waits real milliseconds. */
  sleep?: (ms: number) => Promise<void>;
}

const SECRETS = [OAUTH_CLIENT_SECRET, REFRESH_TOKEN_SECRET] as const;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function requestFor(ctx: PluginContext, opts: GoogleConnectorOptions): GoogleRequestFn {
  const fetchImpl = opts.fetch ?? fetch;
  const tokens = new GoogleTokenSource({ secrets: ctx.secrets, clock: ctx.clock, fetch: fetchImpl });
  const sleep = opts.sleep ?? defaultSleep;
  return <T>(url: string, init?: RequestInit): Promise<T> =>
    googleRequest<T>({ fetch: fetchImpl, tokens, sleep }, url, init);
}

/** Connector for the owner's primary Google Calendar. */
export function googleCalendarConnector(opts: GoogleConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.google-calendar',
      kind: 'connector',
      title: 'Google Calendar',
      secrets: [...SECRETS],
    },
    setup(ctx) {
      const calendar = new GoogleCalendar({
        request: requestFor(ctx, opts),
        timeZone: ctx.assistant.timezone,
      });
      ctx.provide(Contracts.calendarRead, calendar);
      ctx.provide(Contracts.calendarWrite, calendar);
    },
  };
}

/** Connector for the owner's Gmail mailbox. */
export function gmailConnector(opts: GoogleConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.gmail',
      kind: 'connector',
      title: 'Gmail',
      secrets: [...SECRETS],
    },
    setup(ctx) {
      const request = requestFor(ctx, opts);
      const mail = new GoogleMail({ request, clock: ctx.clock });
      ctx.provide(Contracts.mailRead, mail);
      ctx.provide(Contracts.mailDraft, mail);
      ctx.provide(Contracts.mailSend, mail);
      ctx.provide(Contracts.mailAwaiting, mail);
      ctx.provide(Contracts.mailAttachments, new GmailAttachments({ request }));
      ctx.provide(Contracts.mailCompose, new GmailComposer({ request }));
      // `ax-kit connect google` sets this only when the owner granted gmail.modify ("Gmail 정리").
      if (ctx.config['organize'] === true) ctx.provide(Contracts.mailOrganize, new GmailOrganizer({ request }));
    },
  };
}
