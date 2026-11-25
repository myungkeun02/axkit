import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { GOOGLE_SECRETS } from './accounts.js';
import { accountRequest, accountServices } from './account-services.js';
import { GoogleCalendar } from './calendar.js';
import { GmailAttachments } from './gmail-attachments.js';
import { GmailComposer } from './gmail-compose.js';
import { GmailOrganizer } from './gmail-organize.js';
import { GoogleMail } from './gmail.js';
import { MultiCalendar } from './multi-calendar.js';
import { MultiAttachments, MultiMail, MultiOrganizer } from './multi-mail.js';

export interface GoogleConnectorOptions {
  /** Tests inject a fake; production uses global fetch. */
  fetch?: typeof fetch;
  /** Tests inject a fake; production waits real milliseconds. */
  sleep?: (ms: number) => Promise<void>;
}

/** Connector for the owner's Google Calendar: every shown calendar of every connected account; new events where the draft says. */
export function googleCalendarConnector(opts: GoogleConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.google-calendar',
      kind: 'connector',
      title: 'Google Calendar',
      secrets: [...GOOGLE_SECRETS],
    },
    setup(ctx) {
      const make = (key: string): GoogleCalendar =>
        new GoogleCalendar({ request: accountRequest(ctx, opts, key).request, timeZone: ctx.assistant.timezone, now: () => ctx.clock.now().getTime() });
      const calendar = new MultiCalendar(accountServices(ctx, make, make('')));
      ctx.provide(Contracts.calendarRead, calendar);
      ctx.provide(Contracts.calendarWrite, calendar);
    },
  };
}

/** Connector for the owner's Gmail: every connected account; a reply goes from the mailbox the mail is in. */
export function gmailConnector(opts: GoogleConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.gmail',
      kind: 'connector',
      title: 'Gmail',
      secrets: [...GOOGLE_SECRETS],
    },
    setup(ctx) {
      const requests = new Map<string, ReturnType<typeof accountRequest>['request']>();
      const request = (key: string): ReturnType<typeof accountRequest>['request'] => {
        let made = requests.get(key);
        if (made === undefined) {
          made = accountRequest(ctx, opts, key).request;
          requests.set(key, made);
        }
        return made;
      };
      const mailbox = (key: string): GoogleMail => new GoogleMail({ request: request(key), clock: ctx.clock });
      const mail = new MultiMail(accountServices(ctx, mailbox, mailbox('')));
      ctx.provide(Contracts.mailRead, mail);
      ctx.provide(Contracts.mailDraft, mail);
      ctx.provide(Contracts.mailSend, mail);
      ctx.provide(Contracts.mailAwaiting, mail);
      const attachments = (key: string): GmailAttachments => new GmailAttachments({ request: request(key) });
      ctx.provide(Contracts.mailAttachments, new MultiAttachments(accountServices(ctx, attachments, attachments(''))));
      // a new mail (not a reply) goes from the first account
      ctx.provide(Contracts.mailCompose, new GmailComposer({ request: request('') }));
      // `ax-kit connect google` sets this only when the owner granted gmail.modify ("Gmail 정리").
      if (ctx.config['organize'] === true) {
        const organizer = (key: string): GmailOrganizer => new GmailOrganizer({ request: request(key) });
        ctx.provide(Contracts.mailOrganize, new MultiOrganizer(accountServices(ctx, organizer, organizer(''))));
      }
    },
  };
}
