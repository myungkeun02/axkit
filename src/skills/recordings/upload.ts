import type { DeviceApi, DeviceApiResponse } from '../../core/contracts/device-api.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { RecordingStore } from './store.js';
import { MAX_CHUNKS, RECORDING_ID, formatOf } from './store.js';

const bad = (error: string): DeviceApiResponse => ({ status: 400, body: { ok: false, error } });

export interface UploadDeps {
  api: DeviceApi;
  store: RecordingStore;
  clock: Clock;
  /** Called once when the audio is assembled and published; processing runs in the background. */
  onComplete(id: string, audioPath: string): void;
  /** Logs an assembly that failed (the phone is told to send again). */
  warn?(message: string, fields: Record<string, unknown>): void;
}

/**
 * Joins a recording whose chunks have all arrived: `receiving` → `assembling` → (audio published) → `transcribing`.
 * Only one caller wins the move to `assembling`; on failure the recording goes back to `receiving`, so the phone's
 * retry assembles again. Answers the audio path, or undefined when another call is assembling or it failed.
 */
export async function assembleRecording(deps: Omit<UploadDeps, 'api'>, id: string, resuming = false): Promise<string | undefined> {
  const { store, clock } = deps;
  const claimed = await store.update(id, { status: 'assembling' }, clock.now(), (current) =>
    resuming ? current.status === 'assembling' : current.status === 'receiving',
  );
  if (claimed === undefined) return undefined;
  try {
    const path = await store.assemble(id, claimed.total, claimed.format ?? 'm4a');
    await store.update(id, { status: 'transcribing' }, clock.now());
    deps.onComplete(id, path);
    return path;
  } catch (error) {
    deps.warn?.('recordings: the audio could not be assembled', { error: error instanceof Error ? error.message : 'error' });
    await store.update(id, { status: 'receiving' }, clock.now()).catch(() => undefined);
    return undefined;
  }
}

/**
 * `POST recordings/<id>/chunks/<index>`: one ≤12 MB slice of the phone's audio file. Re-sending a chunk overwrites it.
 * The answer says how many chunks arrived without a gap, so an interrupted upload resumes there; `complete` only once
 * the joined audio is safely on disk.
 */
export function registerRecordingUpload(deps: UploadDeps): void {
  const { api, store, clock } = deps;
  api.upload('recordings/:id/chunks/:index', async (upload) => {
    const id = upload.params['id'] ?? '';
    const index = Number(upload.params['index']);
    const total = Number(upload.headers['x-chunk-total']);
    if (!RECORDING_ID.test(id) || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) return bad('shape');
    if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || index >= total) return bad('total');
    const now = clock.now();
    const started = Date.parse(upload.headers['x-started-at'] ?? '');
    const duration = Number(upload.headers['x-duration-sec'] ?? '0');
    const existing = await store.create({
      id,
      startedAt: Number.isFinite(started) ? new Date(started).toISOString() : now.toISOString(),
      durationSec: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0,
      total,
      format: formatOf(upload.contentType),
      status: 'receiving',
      updatedAt: now.toISOString(),
    });
    // Not complete although every chunk is here (joining now, or the join failed): the phone sends the last chunk again.
    const notYet: DeviceApiResponse = { status: 200, body: { ok: true, received: existing.total - 1, complete: false } };
    if (existing.status === 'assembling') return notYet;
    if (existing.status !== 'receiving') {
      return { status: 200, body: { ok: true, received: existing.total, complete: true } };
    }
    await store.saveChunk(id, index, upload.bytes);
    const received = await store.contiguous(id);
    if (received < existing.total) return { status: 200, body: { ok: true, received, complete: false } };
    // two last chunks arriving together: only one moves the recording to `assembling`; the other is not complete yet
    if ((await assembleRecording(deps, id)) === undefined) return notYet;
    return { status: 200, body: { ok: true, received: existing.total, complete: true } };
  });
}
