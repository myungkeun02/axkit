import type { GeoPoint, WeatherReport } from '../../core/contracts/index.js';

const URL_BASE = 'https://api.open-meteo.com/v1/forecast';

/** WMO weather codes → the short Korean words the briefing shows. */
function skyOf(code: number): string {
  if (code === 0) return '맑음';
  if (code <= 2) return '구름 조금';
  if (code === 3) return '흐림';
  if (code === 45 || code === 48) return '안개';
  if (code >= 51 && code <= 67) return '비';
  if (code >= 71 && code <= 77) return '눈';
  if (code >= 80 && code <= 82) return '소나기';
  if (code >= 85 && code <= 86) return '눈';
  if (code >= 95) return '뇌우';
  return '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function at(list: unknown, index: number): number | undefined {
  return Array.isArray(list) ? num(list[index]) : undefined;
}

/**
 * Open-Meteo needs no key: the weather the briefing falls back to before the owner adds the public-data key
 * (KMA). No air quality here. `ymd` picks one local day of the forecast (up to a week ahead).
 */
export async function openMeteo(fetchImpl: typeof fetch, point: GeoPoint, now: Date, ymd?: string): Promise<WeatherReport | undefined> {
  const url = new URL(URL_BASE);
  url.searchParams.set('latitude', point.lat.toFixed(4));
  url.searchParams.set('longitude', point.lng.toFixed(4));
  url.searchParams.set('current', 'temperature_2m,weather_code');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');
  const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Open-Meteo answered ${String(response.status)}`);
  const data = (await response.json()) as { current?: Record<string, unknown>; daily?: Record<string, unknown> };
  const days = Array.isArray(data.daily?.time) ? (data.daily.time as unknown[]) : [];
  const index = ymd === undefined ? 0 : days.indexOf(ymd);
  if (index < 0) return undefined;
  const today = ymd === undefined || index === 0;
  const code = (today ? num(data.current?.weather_code) : undefined) ?? at(data.daily?.weather_code, index) ?? -1;
  const tempC = today ? num(data.current?.temperature_2m) : undefined;
  const minC = at(data.daily?.temperature_2m_min, index);
  const maxC = at(data.daily?.temperature_2m_max, index);
  const rainChance = at(data.daily?.precipitation_probability_max, index);
  return {
    sky: skyOf(code),
    ...(tempC !== undefined ? { tempC: Math.round(tempC) } : {}),
    ...(minC !== undefined ? { minC: Math.round(minC) } : {}),
    ...(maxC !== undefined ? { maxC: Math.round(maxC) } : {}),
    ...(rainChance !== undefined ? { rainChance } : {}),
    observedAt: now,
  };
}
