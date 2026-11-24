import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The public Android app, built and signed once, for Macs that cannot build it (no Java, SDK or app code). */
export const ANDROID_RELEASE = 'https://github.com/myungkeun02/axkit-android/releases/latest/download';
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Downloads the released APK and its ax-kit.json next to where `phone apk` keeps its own build. */
export async function downloadReleaseApk(apkPath: string, fetchImpl: typeof fetch = fetch, base = ANDROID_RELEASE): Promise<string> {
  const get = async (name: string): Promise<Buffer> => {
    const response = await fetchImpl(`${base}/${name}`, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`공개된 안드로이드 앱을 받지 못했어요 (${name}: ${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [apk, info] = await Promise.all([get('ax-kit.apk'), get('ax-kit.json')]);
  const parsed = JSON.parse(info.toString('utf8')) as Record<string, unknown>;
  // the update check trusts the size, so the info must describe these bytes
  if (parsed['size'] !== apk.length) throw new Error('공개된 안드로이드 앱 파일이 설명과 달라요. 잠시 뒤 다시 해 주세요.');
  await mkdir(dirname(apkPath), { recursive: true });
  await writeFile(`${apkPath}.part`, apk);
  await rename(`${apkPath}.part`, apkPath);
  await writeFile(join(dirname(apkPath), 'ax-kit.json'), info);
  return apkPath;
}
