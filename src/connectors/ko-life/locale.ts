import { KO_SECRETS } from './secrets.js';
import type { KoSecretName } from './secrets.js';

export interface KoLifeTexts {
  readonly guides: Readonly<Record<KoSecretName, string>>;
  readonly delivered: string;
  readonly inTransit: string;
  readonly tagoCityMissing: string;
  tagoCityUnknown(city: string): string;
  /** "3분 후 (2정거장 전)" style wording for a TAGO bus arrival. */
  tagoArrival(minutes: number, stations?: number): string;
}

const KO: KoLifeTexts = {
  guides: {
    [KO_SECRETS.dataGoKr]:
      "공공데이터포털(data.go.kr)에서 회원가입한 뒤 '기상청 단기예보', '한국환경공단 에어코리아 대기오염정보', " +
      "'서울 버스정류장 정보' 활용 신청을 승인받고, 발급된 일반 인증키를 " +
      '`ax-kit secret set ko.data-go-kr.key`로 넣어 주세요.',
    [KO_SECRETS.seoulData]:
      "서울 열린데이터광장(data.seoul.go.kr)에서 '지하철 실시간 도착정보' 사용 신청을 하고 인증키를 받아 " +
      '`ax-kit secret set ko.seoul-data.key`로 넣어 주세요.',
    [KO_SECRETS.odsay]:
      'ODsay LAB(lab.odsay.com)에서 회원가입 후 서버용 API 키를 만들고(맥의 공인 IP를 등록) ' +
      '`ax-kit secret set ko.odsay.key`로 넣어 주세요. 대중교통 길찾기에 써요.',
    [KO_SECRETS.kakaoRest]:
      "카카오 개발자(developers.kakao.com)에서 앱을 만들고 카카오맵(로컬) 사용을 켠 뒤 REST API 키를 " +
      '`ax-kit secret set ko.kakao.rest-key`로 넣어 주세요.',
    [KO_SECRETS.sweetTracker]:
      "스마트택배(sweettracker.co.kr)에서 운송장 조회 API 사용을 신청하고 발급된 키를 " +
      '`ax-kit secret set ko.sweettracker.key`로 넣어 주세요.',
    [KO_SECRETS.naverClientId]:
      "네이버 개발자(developers.naver.com)에서 앱을 만들고 '검색' API를 추가한 뒤 Client ID를 " +
      '`ax-kit secret set ko.naver.client-id`로 넣어 주세요.',
    [KO_SECRETS.naverClientSecret]:
      "네이버 개발자(developers.naver.com)에서 앱을 만들고 '검색' API를 추가한 뒤 Client Secret을 " +
      '`ax-kit secret set ko.naver.client-secret`로 넣어 주세요.',
  },
  delivered: '배송완료',
  inTransit: '배송중',
  tagoCityMissing:
    "버스 도착 정보는 시 단위로 제공돼요. 플러그인 설정의 transitCity에 '대전'처럼 도시 이름을 넣어 주세요.",
  tagoCityUnknown: (city) =>
    `"${city}" 도시 코드를 찾지 못했어요. 플러그인 설정의 transitCity를 확인해 주세요.`,
  tagoArrival: (minutes, stations) =>
    stations === undefined ? `${minutes}분 후` : `${minutes}분 후 (${stations}정거장 전)`,
};

const EN: KoLifeTexts = {
  guides: {
    [KO_SECRETS.dataGoKr]:
      'Sign in to data.go.kr, apply for the KMA short-term forecast, AirKorea air quality and Seoul bus stop ' +
      'services, then add the issued key with `ax-kit secret set ko.data-go-kr.key`.',
    [KO_SECRETS.seoulData]:
      'Apply for real-time subway arrivals at data.seoul.go.kr, then add the key with ' +
      '`ax-kit secret set ko.seoul-data.key`.',
    [KO_SECRETS.odsay]:
      'Create a server API key at lab.odsay.com (register this Mac\'s public IP), then add it with ' +
      '`ax-kit secret set ko.odsay.key`. Used for public transit directions.',
    [KO_SECRETS.kakaoRest]:
      'Create an app at developers.kakao.com, enable Kakao Map (Local), then add the REST key with ' +
      '`ax-kit secret set ko.kakao.rest-key`.',
    [KO_SECRETS.sweetTracker]:
      'Apply for the Sweet Tracker delivery API, then add the key with ' +
      '`ax-kit secret set ko.sweettracker.key`.',
    [KO_SECRETS.naverClientId]:
      'Create an app at developers.naver.com, add the Search API, then add the Client ID with ' +
      '`ax-kit secret set ko.naver.client-id`.',
    [KO_SECRETS.naverClientSecret]:
      'Create an app at developers.naver.com, add the Search API, then add the Client Secret with ' +
      '`ax-kit secret set ko.naver.client-secret`.',
  },
  delivered: 'Delivered',
  inTransit: 'In transit',
  tagoCityMissing:
    'Bus arrivals are provided per city. Set transitCity in the plugin config to a city name such as "Daejeon".',
  tagoCityUnknown: (city) => `Could not find a city code for "${city}". Check transitCity in the plugin config.`,
  tagoArrival: (minutes, stations) =>
    stations === undefined ? `${minutes} min away` : `${minutes} min away (${stations} stops before)`,
};

export function koLifeTexts(language: string): KoLifeTexts {
  return language === 'en' ? EN : KO;
}
