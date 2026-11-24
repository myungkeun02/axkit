/** Keychain names the Korean life connector may read. */
export const KO_SECRETS = {
  dataGoKr: 'ko.data-go-kr.key',
  seoulData: 'ko.seoul-data.key',
  kakaoRest: 'ko.kakao.rest-key',
  odsay: 'ko.odsay.key',
  sweetTracker: 'ko.sweettracker.key',
  naverClientId: 'ko.naver.client-id',
  naverClientSecret: 'ko.naver.client-secret',
} as const;

export type KoSecretName = (typeof KO_SECRETS)[keyof typeof KO_SECRETS];

export const KO_SECRET_NAMES: readonly KoSecretName[] = Object.values(KO_SECRETS);
