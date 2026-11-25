/**
 * Capability "device.api", provided by bridge.mobile: lets another plugin (the phone app channel) serve routes under
 * `/m/v1/app/` behind the bridge's token check, rate limit and size caps. Only devices paired as the app reach them.
 */
export interface DeviceCaller {
  deviceId: string;
  deviceName: string;
  /** What the device was paired as, so texts can say "from the desktop" instead of "from the phone". */
  platform?: 'ios' | 'android' | 'desktop';
}

export interface DeviceApiRequest {
  caller: DeviceCaller;
  /** Values for `:name` segments of the registered path. */
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  /** Parsed JSON body for POST; undefined for GET. Untrusted input: validate it. */
  body: unknown;
}

export interface DeviceApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface DeviceUpload {
  caller: DeviceCaller;
  /** File name the phone gave, already stripped of path separators. */
  name: string;
  contentType: string;
  bytes: Buffer;
  /** Path parameters of a pattern like "recordings/:id/chunks/:index". */
  params: Record<string, string>;
  /** Only `x-chunk-total`, `x-started-at`, `x-duration-sec`, `x-channel`, lower-cased; nothing else reaches handlers. */
  headers: Record<string, string>;
  /** Aborted when the device goes away before the answer (it cancelled): long work can stop. */
  signal?: AbortSignal;
}

/** A server-sent event stream to one device. */
export interface DeviceEventStream {
  send(event: string, data: unknown, id?: string): void;
  /** Called once when the phone disconnects or the server stops. */
  onClose(listener: () => void): void;
  close(): void;
}

export type DeviceApiHandler = (request: DeviceApiRequest) => Promise<DeviceApiResponse>;

/** Raw bytes for a `GET` download route (an image the app shows). Undefined answers 404. */
export interface DeviceFile {
  bytes: Buffer;
  contentType: string;
  name: string;
}

export interface DeviceApi {
  /** `path` is relative to `/m/v1/app/`, e.g. "messages" or "cards/:id". */
  route(method: 'GET' | 'POST', path: string, handler: DeviceApiHandler): void;
  /** Raw-body upload (photos, audio) with a larger cap than JSON routes. */
  upload(path: string, handler: (upload: DeviceUpload) => Promise<DeviceApiResponse>): void;
  /** Long-lived `text/event-stream`. `lastEventId` is the phone's Last-Event-ID header, if any. */
  stream(path: string, open: (caller: DeviceCaller, stream: DeviceEventStream, lastEventId?: string) => void): void;
  /** `GET` route answering raw bytes instead of JSON, e.g. "files/:id". */
  download(path: string, handler: (request: DeviceApiRequest) => Promise<DeviceFile | undefined>): void;
  /**
   * Whether a device is still paired. The device list lives in the bridge (and the CLI revokes from another process),
   * so a plugin holding per-device state (a push token) asks before using it.
   */
  deviceActive(deviceId: string): Promise<boolean>;
}

/** Emitted by the bridge when the app unpairs itself; per-device state (push tokens) goes with it. */
export interface PhoneDeviceRevoked {
  deviceId: string;
}

/** A file the owner shared from the phone app (photo, audio, document), saved under ~/.ax-kit/files/inbox. */
export interface PhoneSharedFile {
  deviceId: string;
  path: string;
  name: string;
  contentType: string;
  size: number;
  at: Date;
}

declare module '../events/types.js' {
  interface EventMap {
    'phone.shared_file': PhoneSharedFile;
    'phone.device_revoked': PhoneDeviceRevoked;
  }
}

/** A read-only screen's data (knowledge docs, usage, approvals...). Clients find them through `capabilities`. */
export interface AppView {
  /** "usage", "knowledge-docs" (letters, digits, - and _); served at `/m/v1/app/views/<name>`. */
  name: string;
  /** Bumped when the response shape changes incompatibly. */
  version: number;
  /**
   * R9: a screen the server draws. `read` answers `{title, blocks}` and the app lists it under More › 새 기능 with
   * this title and SF Symbol, so a new ability shows up without an app update.
   */
  ui?: 'blocks';
  title?: string;
  icon?: string;
  read(query: URLSearchParams): Promise<Record<string, unknown>>;
  /**
   * `POST views/<name>/<action>`: the owner's own reversible edits (fix a knowledge line). Never send, pay or delete —
   * those go through chat and a confirmation card. Throw `ViewInputError` for bad input (answered as 400).
   */
  actions?: Readonly<Record<string, (body: unknown) => Promise<Record<string, unknown>>>>;
}

export class ViewInputError extends Error {
  override readonly name = 'ViewInputError';
  /** True when the message is a plain sentence for the owner (sent as `message`); false for developer-only texts. */
  readonly forOwner: boolean;

  constructor(message: string, options: { forOwner?: boolean } = {}) {
    super(message);
    this.forOwner = options.forOwner === true;
  }
}

/** A refusal the app shows as is ("그런 봇이 없어요"); the 400 body carries it as `message`. */
export function ownerInputError(message: string): ViewInputError {
  return new ViewInputError(message, { forOwner: true });
}

/** Capability "app.views", provided by channel.app: the extension point for read-only views beyond chat. */
export interface AppViewRegistry {
  register(view: AppView): void;
  /** Lists a feature name in `capabilities.features` (e.g. "recordings"), so clients show its screens. */
  addFeature?(name: string): void;
}
