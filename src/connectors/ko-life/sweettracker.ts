import { z } from 'zod';
import type { ParcelStatus, ParcelTracker } from '../../core/contracts/index.js';
import type { KoLifeDeps } from './deps.js';
import { keyOf } from './deps.js';
import { fetchJson, parseShape } from './http.js';
import { KO_SECRETS } from './secrets.js';

const COMPANY_URL = 'https://info.sweettracker.co.kr/api/v1/companylist';
const TRACKING_URL = 'https://info.sweettracker.co.kr/api/v1/trackingInfo';
const CACHE_KEY = 'carriers';
const CACHE_MS = 24 * 60 * 60 * 1_000;

const Company = z.object({
  Code: z.union([z.string(), z.number()]),
  Name: z.string(),
});

const CompanyList = z.object({
  Company: z.array(Company).optional(),
  company: z.array(Company).optional(),
});

const Tracking = z
  .object({
    status: z.boolean().optional(),
    complete: z.boolean().optional(),
    trackingDetails: z
      .array(
        z.object({
          timeString: z.string().optional(),
          where: z.string().optional(),
          kind: z.string().optional(),
        }),
      )
      .optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.complete !== undefined ||
      value.trackingDetails !== undefined,
  );

interface CachedCarriers {
  at: string;
  list: { code: string; name: string }[];
}

function cacheAge(deps: KoLifeDeps, cached: CachedCarriers): number | undefined {
  const at = Date.parse(cached.at);
  if (Number.isNaN(at)) return undefined;
  return deps.clock.now().getTime() - at;
}

/** Sweet Tracker: carrier list (cached one day) and individual invoice tracking. */
export class SweetTracker implements ParcelTracker {
  constructor(private readonly deps: KoLifeDeps) {}

  async carriers(): Promise<{ code: string; name: string }[]> {
    const cached = await this.deps.kv.get<CachedCarriers>(CACHE_KEY);
    if (cached !== undefined && Array.isArray(cached.list)) {
      const age = cacheAge(this.deps, cached);
      if (age !== undefined && age >= 0 && age < CACHE_MS) return cached.list;
    }

    const key = await keyOf(this.deps, KO_SECRETS.sweetTracker);
    const params = new URLSearchParams({ t_key: key });
    const body = parseShape(
      CompanyList,
      await fetchJson(this.deps.fetch, `${COMPANY_URL}?${params}`),
      'Sweet Tracker',
    );
    const rows = body.Company ?? body.company;
    if (rows === undefined) throw new Error('Sweet Tracker returned an unexpected response.');
    const list = rows
      .map((row) => ({ code: String(row.Code), name: row.Name.trim() }))
      .filter((row) => row.code !== '' && row.name !== '');
    if (list.length > 0) {
      await this.deps.kv.set<CachedCarriers>(CACHE_KEY, {
        at: this.deps.clock.now().toISOString(),
        list,
      });
    }
    return list;
  }

  async track(carrierCode: string, invoice: string): Promise<ParcelStatus> {
    const key = await keyOf(this.deps, KO_SECRETS.sweetTracker);
    const params = new URLSearchParams({ t_key: key, t_code: carrierCode, t_invoice: invoice });
    const body = parseShape(
      Tracking,
      await fetchJson(this.deps.fetch, `${TRACKING_URL}?${params}`),
      'Sweet Tracker',
    );
    if (body.status === false) throw new Error('Sweet Tracker rejected the tracking request.');

    const details = body.trackingDetails ?? [];
    const last = details.at(-1);
    const delivered = body.complete === true;
    const lastEvent =
      last === undefined
        ? undefined
        : {
            at: last.timeString ?? '',
            where: last.where ?? '',
            what: last.kind ?? '',
          };
    return {
      carrier: carrierCode,
      invoice,
      state: lastEvent?.what !== undefined && lastEvent.what !== ''
        ? lastEvent.what
        : delivered
          ? this.deps.texts.delivered
          : this.deps.texts.inTransit,
      ...(lastEvent !== undefined ? { lastEvent } : {}),
      delivered,
    };
  }
}
