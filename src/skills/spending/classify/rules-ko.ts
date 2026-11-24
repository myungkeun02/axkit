import type { SpendCategory } from '../../../core/contracts/index.js';

export interface CategoryRule {
  category: SpendCategory;
  pattern: RegExp;
}

/** Korean everyday merchants. Narrow subscription names come before broad shopping names. */
export const KO_RULES: readonly CategoryRule[] = [
  {
    category: 'subscription',
    pattern: /넷플릭스|유튜브\s*프리미엄|유튜브뮤직|스포티파이|멜론|티빙|왓챠|디즈니|쿠팡와우|네이버플러스|애플\s*뮤직|아이클라우드/i,
  },
  {
    category: 'food',
    pattern: /배달의민족|배민|쿠팡이츠|요기요|식당|김밥|치킨|피자|분식|버거|맥도날드|롯데리아|서브웨이|베이커리|파리바게뜨|뚜레쥬르/i,
  },
  { category: 'cafe', pattern: /스타벅스|투썸|이디야|메가커피|컴포즈|빽다방|카페|커피/i },
  {
    category: 'groceries',
    pattern: /이마트|홈플러스|롯데마트|gs\s*25|\bcu\b|세븐일레븐|마트|편의점|코스트코|컬리/i,
  },
  {
    category: 'transport',
    pattern: /택시|카카오\s*t|카카오모빌리티|티머니|코레일|srt|ktx|고속버스|주유|주차|하이패스|쏘카|따릉이/i,
  },
  {
    category: 'shopping',
    pattern: /쿠팡|11번가|g마켓|지마켓|옥션|무신사|올리브영|다이소|네이버\s*쇼핑|네이버페이|스마트스토어|오늘의집/i,
  },
  { category: 'health', pattern: /병원|의원|약국|치과|한의원|안과|피부과|정형외과/i },
  { category: 'culture', pattern: /cgv|메가박스|롯데시네마|교보문고|예스24|서점|영화관/i },
  {
    category: 'travel',
    pattern: /호텔|항공|에어비앤비|아고다|야놀자|여기어때|제주항공|진에어|대한항공|아시아나/i,
  },
  {
    category: 'living',
    pattern: /관리비|통신|전기|가스|수도|한국전력|\bkt\b|skt|lg\s*u\+|보험|세탁/i,
  },
  { category: 'education', pattern: /학원|강의|인프런|클래스101|유데미|온라인\s*강의/i },
  { category: 'transfer', pattern: /이체|송금|출금|자동이체/i },
];
