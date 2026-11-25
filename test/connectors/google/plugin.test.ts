import { describe, expect, it } from 'vitest';
import { gmailConnector, googleCalendarConnector } from '../../../src/connectors/google/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import { fakeFetch, json } from './helpers.js';

describe('googleCalendarConnector', () => {
  it('provides read and write over the stored credentials', async () => {
    const { ctx, secrets } = createTestContext();
    await secrets.set('google.oauth-client', JSON.stringify({ clientId: 'client-id', clientSecret: 'secret' }));
    await secrets.set('google.refresh-token', 'refresh-1');

    const fake = fakeFetch((call) =>
      call.url.hostname === 'oauth2.googleapis.com'
        ? json({ access_token: 'access-1', expires_in: 3600 })
        : json({ items: [] }),
    );
    const plugin = googleCalendarConnector({ fetch: fake.fetch, sleep: async () => undefined });

    await plugin.setup(ctx);

    expect(plugin.manifest).toMatchObject({
      id: 'connector.google-calendar',
      kind: 'connector',
      title: 'Google Calendar',
      secrets: expect.arrayContaining(['google.oauth-client', 'google.refresh-token', 'google.accounts']),
    });

    const reader = ctx.use(Contracts.calendarRead);
    const writer = ctx.use(Contracts.calendarWrite);
    expect(writer).toBe(reader);
    await expect(
      reader.listEvents({ from: new Date('2026-11-17T00:00:00Z'), to: new Date('2026-11-18T00:00:00Z') }),
    ).resolves.toEqual([]);

    expect(fake.calls[0]?.url.hostname).toBe('oauth2.googleapis.com');
    expect(fake.calls.find((call) => call.url.pathname.endsWith('/events'))?.url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(fake.calls.find((call) => call.url.pathname.endsWith('/events'))?.headers.get('authorization')).toBe('Bearer access-1');
  });
});

describe('gmailConnector', () => {
  it('provides the mail read, draft and send capabilities', async () => {
    const { ctx } = createTestContext();
    const plugin = gmailConnector();

    await plugin.setup(ctx);

    expect(plugin.manifest).toMatchObject({
      id: 'connector.gmail',
      kind: 'connector',
      title: 'Gmail',
      secrets: expect.arrayContaining(['google.oauth-client', 'google.refresh-token', 'google.accounts']),
    });
    expect(ctx.tryUse(Contracts.mailRead)).toBeDefined();
    expect(ctx.tryUse(Contracts.mailDraft)).toBeDefined();
    expect(ctx.tryUse(Contracts.mailSend)).toBeDefined();
    expect(ctx.tryUse(Contracts.mailSend)).toBe(ctx.tryUse(Contracts.mailRead));
  });
});
