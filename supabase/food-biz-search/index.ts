// 공공데이터포털 프록시: 식품 인허가(행정안전부) + 상가(상권)정보(소상공인시장진흥공단) + 우편번호(우정사업본부)
// 인증키는 Edge Function 시크릿 DATA_GO_KR_KEY 에만 저장됩니다.
// 접속 비밀번호는 시크릿 ACCESS_PASSWORD (헤더 x-access-pw 로 확인)

const ENDPOINTS: Record<string, string> = {
  instant: 'https://apis.data.go.kr/1741000/instant_food_processors', // 즉석판매제조가공업
  retail: 'https://apis.data.go.kr/1741000/other_food_retailers', // 식품판매업(기타)
};
const ZIP_URL = 'http://openapi.epost.go.kr/postal/retrieveNewZipCdService/retrieveNewZipCdService/getNewZipCdList';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-access-pw, content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const clean = (v: string | null, max = 60) => (v ?? '').trim().slice(0, max);
const ymd = (v: string | null) => { const s = clean(v).replace(/-/g, ''); return /^\d{8}$/.test(s) ? s : ''; };

// ---------- 우편번호 ----------
const zipCache = new Map<string, string>();

// 주소에서 검색에 필요한 부분만 남김: 도로명은 건물번호까지, 지번은 번지까지
function zipQuery(addr: string): string {
  let a = addr.replace(/\(.*?\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim();
  const road = a.match(/^(.*?(?:로|길)\s?\d+(?:-\d+)?)(?=\s|$)/);
  if (road) return road[1];
  const lot = a.match(/^(.*?(?:동|리|가|읍|면)\s(?:산\s?)?\d+(?:-\d+)?)(?=\s|$|[^\d-])/);
  if (lot) return lot[1];
  return a.slice(0, 60);
}

async function lookupZip(key: string, addr: string): Promise<string> {
  const q = zipQuery(addr);
  if (!q) return '';
  if (zipCache.has(q)) return zipCache.get(q)!;
  const url = `${ZIP_URL}?serviceKey=${encodeURIComponent(key)}&srchwrd=${encodeURIComponent(q)}&countPerPage=1&currentPage=1`;
  try {
    const t = await (await fetch(url)).text();
    if (/<returnCode>(\d+)</.exec(t)?.[1] === '30') throw new Error('KEY');
    const z = /<zipNo>(\d{5})<\/zipNo>/.exec(t)?.[1] ?? '';
    zipCache.set(q, z);
    return z;
  } catch (e) {
    if ((e as Error).message === 'KEY') throw e;
    return '';
  }
}

async function handleZip(req: Request, key: string) {
  let addrs: unknown;
  try { addrs = (await req.json())?.addrs; } catch { /* ignore */ }
  if (!Array.isArray(addrs)) return json(400, { error: 'addrs 배열이 필요합니다.' });
  const list = addrs.slice(0, 100).map((a) => (typeof a === 'string' ? a.slice(0, 200) : ''));
  const out: string[] = new Array(list.length).fill('');
  let i = 0;
  try {
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < list.length) { const n = i++; out[n] = list[n] ? await lookupZip(key, list[n]) : ''; }
    }));
  } catch {
    return json(502, { error: '우편번호 API 인증키가 등록되지 않았습니다.' });
  }
  return json(200, { zips: out });
}

// ---------- 소상공인시장진흥공단 상가(상권)정보 ----------
const SDSC = 'https://apis.data.go.kr/B553077/api/open/sdsc2';
const SDSC_OPS = new Set(['storeListInDong', 'storeListInRadius', 'storeListInUpjong', 'storeOne',
  'largeUpjongList', 'middleUpjongList', 'smallUpjongList', 'baroApi']);
const SDSC_PARAMS = ['divId', 'key', 'indsLclsCd', 'indsMclsCd', 'indsSclsCd', 'radius', 'cx', 'cy',
  'resId', 'catId', 'ctprvnCd', 'signguCd', 'adongCd'];

async function handleStore(q: URLSearchParams, key: string) {
  const api = q.get('api') ?? '';
  if (!SDSC_OPS.has(api)) return json(400, { error: '지원하지 않는 상가정보 조회입니다.' });
  const params: [string, string][] = [['serviceKey', key], ['type', 'json']];
  if (api.startsWith('storeList')) {
    params.push(['pageNo', String(Math.max(1, parseInt(q.get('pageNo') ?? '1', 10) || 1))]);
    params.push(['numOfRows', String(Math.min(1000, Math.max(1, parseInt(q.get('numOfRows') ?? '100', 10) || 100)))]);
  }
  for (const p of SDSC_PARAMS) { const v = clean(q.get(p), 30); if (v) params.push([p, v]); }
  const url = `${SDSC}/${api}?` + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  try {
    const text = await (await fetch(url, { headers: { Accept: 'application/json' } })).text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      const msg = /<returnAuthMsg>(.*?)</.exec(text)?.[1] || /<resultMsg>(.*?)</.exec(text)?.[1] || '';
      return json(502, { error: msg.includes('SERVICE_KEY') ? '상가정보 API 인증키가 아직 활성화되지 않았습니다. 활용신청 승인 후 1~2시간 뒤 다시 시도하세요.' : '상가정보 응답을 해석하지 못했습니다.', detail: text.slice(0, 300) });
    }
    const root = data?.response ?? data;
    const header = root?.header ?? {};
    if (header.resultCode === '03') return json(200, { totalCount: 0, items: [], stdrYm: header.stdrYm ?? '' });
    if (header.resultCode && header.resultCode !== '00' && header.resultCode !== '0') {
      return json(502, { error: header.resultMsg || '상가정보 조회 실패', code: header.resultCode });
    }
    const body = root?.body ?? {};
    let items = body?.items?.item ?? body?.items ?? [];
    if (!Array.isArray(items)) items = [items];
    return json(200, { totalCount: body.totalCount ?? items.length, pageNo: body.pageNo, numOfRows: body.numOfRows, stdrYm: header.stdrYm ?? '', items });
  } catch (e) {
    return json(502, { error: '상가정보 API 연결 실패', detail: String(e).slice(0, 200) });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const q0 = new URL(req.url).searchParams;
  // 업종·지역 분류 목록은 공개 기준정보라 비밀번호 없이 허용 (업체 목록은 보호)
  const isMeta = q0.get('op') === 'store' && /^(largeUpjongList|middleUpjongList|smallUpjongList|baroApi)$/.test(q0.get('api') ?? '');
  const pw = Deno.env.get('ACCESS_PASSWORD');
  if (pw && !isMeta && req.headers.get('x-access-pw') !== pw) return json(401, { error: '접속 비밀번호가 올바르지 않습니다.' });

  const key = Deno.env.get('DATA_GO_KR_KEY');
  if (!key) return json(500, { error: '서버에 DATA_GO_KR_KEY 시크릿이 아직 없습니다.' });

  const q = new URL(req.url).searchParams;
  if (q.get('op') === 'zip' && req.method === 'POST') return handleZip(req, key);
  if (q.get('op') === 'store') return handleStore(q, key);

  const base = ENDPOINTS[q.get('type') ?? ''] ?? ENDPOINTS.instant;
  const op = q.get('op') === 'history' ? 'history' : 'info';
  const pageNo = Math.max(1, parseInt(q.get('pageNo') ?? '1', 10) || 1);
  const numOfRows = Math.min(100, Math.max(1, parseInt(q.get('numOfRows') ?? '50', 10) || 50));

  const params: [string, string][] = [
    ['serviceKey', key], ['pageNo', String(pageNo)], ['numOfRows', String(numOfRows)], ['returnType', 'json'],
  ];
  const cond = (name: string, value: string) => { if (value) params.push([`cond[${name}]`, value]); };
  cond('BPLC_NM::LIKE', clean(q.get('name')));
  if (op === 'info') cond('ROAD_NM_ADDR::LIKE', clean(q.get('addr')));
  const status = q.get('status') ?? '';
  if (/^\d{2}$/.test(status)) cond('SALS_STTS_CD::EQ', status);
  cond('LCPMT_YMD::GTE', ymd(q.get('from')));
  cond('LCPMT_YMD::LT', ymd(q.get('to')));
  const region = q.get('region') ?? '';
  if (/^\d{7}$/.test(region)) cond('OPN_ATMY_GRP_CD::EQ', region);
  if (op === 'history') cond('BASE_DATE::EQ', ymd(q.get('baseDate')));

  const url = `${base}/${op}?` + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await r.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      return json(502, { error: '공공데이터포털 응답을 해석하지 못했습니다.', detail: text.slice(0, 300) });
    }
    const header = data?.response?.header ?? {};
    if (header.resultCode && header.resultCode !== '0' && header.resultCode !== '00') {
      return json(502, { error: header.resultMsg || '조회 실패', code: header.resultCode });
    }
    const body = data?.response?.body ?? {};
    let items = body?.items?.item ?? [];
    if (!Array.isArray(items)) items = [items];
    return json(200, { totalCount: body.totalCount ?? 0, pageNo: body.pageNo ?? pageNo, numOfRows: body.numOfRows ?? numOfRows, items });
  } catch (e) {
    return json(502, { error: '공공데이터포털 연결 실패', detail: String(e).slice(0, 200) });
  }
});
