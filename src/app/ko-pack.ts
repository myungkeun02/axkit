import { KO_SECRETS } from '../connectors/ko-life/secrets.js';
import type { KoSecretName } from '../connectors/ko-life/secrets.js';

export interface KoreanPackKey {
  secret: KoSecretName;
  /** Which tools cannot work without it. Doctor shows this so a missing key names its feature. */
  features: string;
}

/** Keychain names the Korean pack reads, in the order setup asks for them. */
export const KOREAN_PACK_KEYS: readonly KoreanPackKey[] = [
  { secret: KO_SECRETS.dataGoKr, features: 'weather, air quality, bus stops' },
  { secret: KO_SECRETS.seoulData, features: 'subway arrivals' },
  { secret: KO_SECRETS.kakaoRest, features: 'places, geocoding, car directions' },
  { secret: KO_SECRETS.odsay, features: 'public transit directions' },
  { secret: KO_SECRETS.sweetTracker, features: 'parcel tracking' },
  { secret: KO_SECRETS.naverClientId, features: 'price search' },
  { secret: KO_SECRETS.naverClientSecret, features: 'price search' },
];
