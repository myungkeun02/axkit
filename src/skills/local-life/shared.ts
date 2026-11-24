import { z } from 'zod';
import { MissingKeyError } from '../../core/contracts/index.js';
import type { GeoPoint, PhoneSignals, PlaceSource } from '../../core/contracts/index.js';
import type { LocalLifeTexts } from './locale.js';

export const PHONE_LOCATION_MAX_AGE_MIN = 180;

export interface NeedsKeyOutput {
  status: 'needs_key';
  secret: string;
  guide: string;
}

export async function withKeys<T>(run: () => Promise<T>): Promise<T | NeedsKeyOutput> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MissingKeyError) {
      return { status: 'needs_key', secret: error.secretName, guide: error.guide };
    }
    throw error;
  }
}

export function isNeedsKey(value: unknown): value is NeedsKeyOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value as { status: unknown }).status === 'needs_key'
  );
}

/** Removes spacing and generic suffixes so "CJ", "cj대한통운" and "대한통운" meet. */
export function normalizeCarrier(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(주\)/g, '')
    .replace(/주식회사/g, '')
    .replace(/택배/g, '')
    .replace(/[\s\-_.]/g, '');
}

export function matchCarrier(
  query: string,
  carriers: readonly { code: string; name: string }[],
): { code: string; name: string } | undefined {
  const raw = query.trim();
  if (raw === '') return undefined;
  const byCode = carriers.find((carrier) => carrier.code === raw);
  if (byCode !== undefined) return byCode;

  const wanted = normalizeCarrier(raw);
  if (wanted === '') return undefined;
  const exact = carriers.find((carrier) => normalizeCarrier(carrier.name) === wanted);
  if (exact !== undefined) return exact;
  return carriers.find((carrier) => {
    const name = normalizeCarrier(carrier.name);
    return name.includes(wanted) || wanted.includes(name);
  });
}

export interface HomeConfig {
  lat: number;
  lng: number;
  label?: string;
}

const HomeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().optional(),
});

/** The skill's own config section may name a home point ("home": {lat, lng, label}). */
export function homeFrom(config: Readonly<Record<string, unknown>>): HomeConfig | undefined {
  const parsed = HomeSchema.safeParse(config.home);
  if (!parsed.success) return undefined;
  return {
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
  };
}

export type LocationFailure =
  | { status: 'need_location'; question: string }
  | { status: 'place_not_found'; place: string; message: string };

export type LocationResult =
  | { ok: true; point: GeoPoint; source: 'said' | 'phone' | 'home'; label?: string }
  | { ok: false; output: LocationFailure };

export interface ResolveLocationInput {
  place?: string;
  places: PlaceSource;
  phone?: PhoneSignals | undefined;
  home?: HomeConfig | undefined;
  texts: LocalLifeTexts;
}

/**
 * A place the owner named > the phone's recent location > the configured home > ask the owner.
 * Never guesses coordinates.
 */
export async function resolveLocation(input: ResolveLocationInput): Promise<LocationResult> {
  const said = input.place?.trim();
  if (said !== undefined && said !== '') {
    const point = await input.places.geocode(said);
    if (point === undefined) {
      return { ok: false, output: { status: 'place_not_found', place: said, message: input.texts.placeNotFound(said) } };
    }
    return { ok: true, point, source: 'said', label: said };
  }

  if (input.phone !== undefined) {
    try {
      const location = await input.phone.latestLocation(PHONE_LOCATION_MAX_AGE_MIN);
      if (location !== undefined) {
        return {
          ok: true,
          point: { lat: location.lat, lng: location.lng },
          source: 'phone',
          ...(location.label !== undefined ? { label: location.label } : {}),
        };
      }
    } catch {
      // A missing phone signal is the same as no location: fall through to home.
    }
  }

  if (input.home !== undefined) {
    return {
      ok: true,
      point: { lat: input.home.lat, lng: input.home.lng },
      source: 'home',
      ...(input.home.label !== undefined ? { label: input.home.label } : {}),
    };
  }

  return { ok: false, output: { status: 'need_location', question: input.texts.askLocation } };
}
