// 우리 동네 비급여 시세표 - 데이터 갱신 스크립트
// 실행: node refresh.mjs
// 심평원 비급여 공개자료는 매년 8월 말~9월 초에 새로 공개됩니다. 공개 직후 1회 돌리면 됩니다.
// 소요: 전국 256개 시군구 약 10~12분, 결과 약 29MB (d/ 폴더 + items.json + sggu.json)

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('.');
const CONC = 10;          // 동시 요청 수 (너무 올리면 심평원 쪽에서 끊길 수 있음)
const PAGE_ROWS = 2000;

// ── 심평원 npay 내부 조회 (인증 없음, CSRF는 double-submit 방식)
const mkBody = (o, csrf, mapName = 'dmParam') => {
  const p = new URLSearchParams();
  p.set('_csrf', csrf);
  for (const [k, v] of Object.entries(o)) p.set('@d1#' + k, String(v));
  p.set('@d#', '@d1#'); p.set('@d1#', mapName); p.set('@d1#tp', 'dm');
  return p.toString();
};
const callHira = async (url, o, mapName = 'dmParam') => {
  const tk = 'x' + Date.now() + Math.random().toString(36).slice(2);
  const r = await fetch('https://www.hira.or.kr/npay' + url, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'Cookie': 'CSRF_TOKEN=' + tk,
      'Referer': 'https://www.hira.or.kr/npay/index.do',
    },
    body: mkBody(o, tk, mapName),
  });
  return r.json();
};
const priceParam = (sidoCd, sgguCd, pageRowCount, currentPageIndex = 1) => ({
  sidoCd, sgguCd, emdongCd: '', sidoNm: '', sgguNm: '', emdongNm: '', clCd: '', yadmNm: '',
  npayCdNm: '', npayCds: '', npayLdivCd: '', ykiho: '', totalRowCount: 0,
  pageRowCount, viewPageCount: 10, currentPageIndex, sortOrd: '',
  npayCd: '', xPos: '', yPos: '', isDev: 'N', schType: '', schDtlTxt: '',
});

// ── 진료과 라벨링 (심평원 공개자료에 진료과 필드가 없어서 기관명 + 신고항목으로 추정)
const SPECS = [
  ['소아청소년과', /소아청소년과/], ['정신건강의학과', /정신건강의학과|신경정신과/],
  ['마취통증의학과', /마취통증의학과|마취과/], ['재활의학과', /재활의학과/],
  ['영상의학과', /영상의학과|방사선과/], ['진단검사의학과', /진단검사의학과/],
  ['직업환경의학과', /직업환경의학과|산업의학과/], ['응급의학과', /응급의학과/],
  ['가정의학과', /가정의학과/], ['성형외과', /성형외과/], ['정형외과', /정형외과/],
  ['신경외과', /신경외과/], ['흉부외과', /흉부외과|심장혈관흉부외과/],
  ['비뇨의학과', /비뇨의학과|비뇨기과/], ['산부인과', /산부인과|여성의원|여성의학과/],
  ['이비인후과', /이비인후과/], ['안과', /안과/], ['피부과', /피부과/], ['신경과', /신경과/],
  ['통증의학과', /통증의학과/], ['병리과', /병리과/], ['핵의학과', /핵의학과/],
  ['결핵과', /결핵과/], ['소아과', /소아과/], ['내과', /내과/], ['외과', /외과/],
];
const MERGE = { '정형·재활': '정형외과', '피부·성형': '피부과', '소아과': '소아청소년과', '통증의학과': '마취통증의학과' };
const byName = (nm, clCd) => {
  if (clCd === '92' || clCd === '93' || /한의원|한방병원/.test(nm)) return '한방';
  if (clCd === '41' || clCd === '51' || /치과/.test(nm)) return '치과';
  for (const [k, re] of SPECS) if (re.test(nm)) return k;
  return '기타';
};
// 기관명으로 못 잡은 의원은 신고 항목 구성으로 보정
const bySignature = (codes, itemDict) => {
  const has = (c) => codes.has(c);
  const anyMdiv = (kw) => [...codes].some((c) => itemDict[c]?.[1]?.includes(kw));
  if (has('2Z9620001') || has('2Z9610001') || anyMdiv('시기능검사')) return '안과';
  if (has('MX1220000') || has('SZ0840000')) return '정형·재활';
  if (['EA0010000', 'EA0020000', 'EA0030000', 'EA0040000'].some(has) || has('EB4140000')) return '내과';
  if (anyMdiv('모발이식')) return '피부·성형';
  return null;
};

const pool = async (items, n, fn) => {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => { for (const x of it) await fn(x); }));
};

async function main() {
  console.log('시도·시군구 코드 수집 중…');
  const sidoRes = await callHira('/rb/selectSidoCdList.do', { sidoCd: '' });
  const sidos = sidoRes.dsSidoCdList;
  const sggus = [];
  for (const s of sidos) {
    const r = await callHira('/rb/selectSgguCdList.do', { sidoCd: s.commCd });
    const key = Object.keys(r).find((k) => Array.isArray(r[k]));
    for (const g of r[key]) sggus.push({ sidoCd: s.commCd, sidoNm: s.commCdNm, c: g.commCd, n: g.commCdNm });
  }
  console.log(`시군구 ${sggus.length}개`);

  const itemDict = {};          // npayCd -> [명칭, 대분류]
  const raw = new Map();        // sgguCd -> {h, p}
  let done = 0;

  await pool(sggus, CONC, async (g) => {
    const hosp = new Map(); const price = [];
    let page = 1, tot = null;
    while (true) {
      const r = await callHira('/rb/selectNpayDamtPubList.do', priceParam(g.sidoCd, g.c, PAGE_ROWS, page));
      const l = r.dsNpayDamtPubList || [];
      if (!l.length) break;
      tot = l[0].totCnt;
      for (const x of l) {
        itemDict[x.npayCd] ||= [x.npayCdNm, x.npayMdivCdNm];
        if (!hosp.has(x.ykiho)) hosp.set(x.ykiho, [x.ykiho, x.yadmNm, x.clCd, x.addr || '', x.yadmGdTelnoTxt || '',
          Math.round((+x.xaxsWgs84Cordnt || 0) * 1e5) / 1e5, Math.round((+x.yaxsWgs84Cordnt || 0) * 1e5) / 1e5]);
        price.push([x.ykiho, x.npayCd, x.minPrc, x.maxPrc]);
      }
      if (price.length >= tot) break;
      page++; if (page > 40) break;
    }
    raw.set(g.c, { g, hosp: [...hosp.values()], price });
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${sggus.length} …`);
  });

  console.log('진료과 라벨링 + 파일 쓰는 중…');
  const itemCodes = Object.keys(itemDict);
  const itemIdx = new Map(itemCodes.map((c, i) => [c, i]));
  await fs.writeFile(path.join(OUT, 'items.json'),
    JSON.stringify(itemCodes.map((c) => [c, itemDict[c][0], itemDict[c][1]])));

  const meta = [];
  for (const { g, hosp, price } of raw.values()) {
    const hIdx = new Map(hosp.map((h, i) => [h[0], i]));
    const codesByH = new Map();
    for (const p of price) {
      const i = hIdx.get(p[0]);
      if (!codesByH.has(i)) codesByH.set(i, new Set());
      codesByH.get(i).add(p[1]);
    }
    const H = hosp.map((h, i) => {
      let L = byName(h[1], h[2]);
      if (L === '기타' && h[2] === '31') L = bySignature(codesByH.get(i) || new Set(), itemDict) || '기타';
      return [h[0], h[1], h[2], MERGE[L] || L, h[3], h[4], h[5], h[6]];
    });
    const P = price.map((p) => [hIdx.get(p[0]), itemIdx.get(p[1]), p[2], p[3]]);
    await fs.writeFile(path.join(OUT, g.c + '.json'),
      JSON.stringify({ s: g.c, n: g.n, sido: g.sidoNm, h: H, p: P }));
    meta.push({ c: g.c, n: g.n, sido: g.sidoNm, hosp: H.length, rows: P.length });
  }
  await fs.writeFile(path.join(OUT, 'sggu.json'), JSON.stringify(meta));

  const totalRows = meta.reduce((a, b) => a + b.rows, 0);
  const totalHosp = meta.reduce((a, b) => a + b.hosp, 0);
  console.log(`완료: 시군구 ${meta.length} · 기관 ${totalHosp.toLocaleString()} · 가격 ${totalRows.toLocaleString()}건 · 항목 ${itemCodes.length}개`);
  console.log('index.html 의 "공개자료 기준일" 문구를 새 공개일로 바꿔주세요.');
}

main().catch((e) => { console.error(e); process.exit(1); });
