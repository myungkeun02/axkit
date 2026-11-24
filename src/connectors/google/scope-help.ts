import type { GoogleRequestFn } from './http.js';
import type { WorkspaceFeature } from './workspace-scopes.js';
import { WORKSPACE_LABELS } from './workspace-scopes.js';

const LIBRARY = 'https://console.cloud.google.com/apis/library';

/** A Google error turned into plain Korean the owner can act on; tools pass the message through unchanged. */
export class GoogleAccessError extends Error {
  constructor(
    message: string,
    readonly reason: 'scope' | 'api' | 'denied' | 'not-found',
  ) {
    super(message);
    this.name = 'GoogleAccessError';
  }
}

export interface AccessTexts {
  /** HTTP 404: the id or address is wrong, or the item is not shared with the owner. */
  notFound?: string;
  /** HTTP 403 that is not about scopes: no right to this one item. */
  denied?: string;
}

/** Korean help for a failed Workspace call, or undefined when the error is something else (network, 5xx). */
export function accessHelp(feature: WorkspaceFeature, message: string, texts: AccessTexts = {}): GoogleAccessError | undefined {
  const { name, api } = WORKSPACE_LABELS[feature];
  if (/\(HTTP 403\)/.test(message)) {
    if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(message)) {
      return new GoogleAccessError(
        `Google Cloud 프로젝트에서 ${api}가 꺼져 있어요. ${LIBRARY} 에서 "${api}"를 찾아 "사용"을 누른 뒤 다시 해 주세요.`,
        'api',
      );
    }
    if (/insufficient|scope/i.test(message)) {
      return new GoogleAccessError(
        `${name} 권한이 아직 없어요. 맥에서 \`ax-kit connect google\`을 실행해 ${name}을(를) 켜고, ` +
          'Google 로그인 화면에서 해당 권한에 체크해 주세요.',
        'scope',
      );
    }
    return new GoogleAccessError(texts.denied ?? '이 항목에 접근할 권한이 없어요. 공유받은 항목인지 확인해 주세요.', 'denied');
  }
  if (/\(HTTP 404\)/.test(message)) {
    return new GoogleAccessError(texts.notFound ?? '그 항목을 찾지 못했어요. 주소나 id를 확인해 주세요.', 'not-found');
  }
  return undefined;
}

/** Wraps a request so permission and "API off" errors read as Korean steps instead of raw HTTP errors. */
export function withAccessHelp(request: GoogleRequestFn, feature: WorkspaceFeature, texts: AccessTexts = {}): GoogleRequestFn {
  return async <T>(url: string, init?: RequestInit): Promise<T> => {
    try {
      return await request<T>(url, init);
    } catch (error) {
      const help = error instanceof Error ? accessHelp(feature, error.message, texts) : undefined;
      throw help ?? error;
    }
  };
}
