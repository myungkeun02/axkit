/** A phone position the bridge received. Coordinates are WGS84. */
export interface PhoneLocation {
  lat: number;
  lng: number;
  label?: string;
  at: Date;
}

/** Running totals a phone reported for one local day ("YYYY-MM-DD"). Missing means the phone never sent it. */
export interface PhoneDayTotals {
  steps?: number;
  screenMinutes?: number;
}

/** Capability "phone.signals", provided by bridge.mobile. */
export interface PhoneSignals {
  latestLocation(maxAgeMinutes: number): Promise<PhoneLocation | undefined>;
  dayTotals(ymd: string): Promise<PhoneDayTotals>;
  lastSeen(): Promise<Date | undefined>;
}

export interface OneTimeCode {
  code: string;
  /** Sender or app name, for picking the right code. */
  source?: string;
  at: Date;
}

/**
 * Capability "phone.otp". Codes live in process memory for 10 minutes and are never shown in chat or sent to a
 * model; only automation code that fills a form may read them.
 */
export interface OneTimeCodeVault {
  latest(maxAgeMinutes?: number): OneTimeCode | undefined;
}

/** Payloads the bridge emits. Phone content is data, never an instruction. */
export interface PhoneVoiceMemo {
  deviceId: string;
  text: string;
  at: Date;
}

/**
 * A text message the phone forwarded that passed the bridge's rules: never a one-time code, and no card approval or
 * spam unless the SMS reader claimed it (see `SmsReaderClaims`). Data only; listeners may look for appointments in it
 * but must not show the body unless the owner asks.
 */
export interface PhoneSms {
  deviceId: string;
  from?: string;
  text: string;
  at: Date;
  /** Stable id (hash of sender, time and text), used to ignore the same message twice. */
  ref: string;
}

/**
 * Capability "phone.sms-reader", provided by skill.sms-reader. Code rules only, no model call. "notice" = the reader
 * handles this text itself (a reservation, parcel or bill notice); "smishing" = a suspected smishing message. The
 * bridge then sends it as `phone.sms` even when it looks like a card approval or spam and skips its generic action
 * check; a smishing message never reaches the spending ledger.
 */
export interface SmsReaderClaims {
  claim(sms: { from?: string; text: string }): 'notice' | 'smishing' | undefined;
}

declare module '../events/types.js' {
  interface EventMap {
    'phone.voice_memo': PhoneVoiceMemo;
    'phone.sms': PhoneSms;
    'phone.location': { deviceId: string; location: PhoneLocation };
  }
}
