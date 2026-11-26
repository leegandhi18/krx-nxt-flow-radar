import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALLOWED_SECTORS = [
  '반도체', '2차전지', '전력·에너지', '바이오·헬스케어', '조선·해양',
  '방산·우주', '자동차·모빌리티', '로봇·자동화', 'AI·SW·플랫폼',
  '금융·지주', '화학·소재', '철강·비철', '건설·기계', '엔터·미디어', '소비재·유통', '기타'
];

function decodeHtml(str = '') {
  return str
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchKindCompanies() {
  console.log('[1/3] 한국거래소(KIND) 상장법인 전체 목록 다운로드 중...');
  const res = await fetch('https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  });
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('euc-kr').decode(buf);

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => decodeHtml(c[1]))
  );

  if (rows.length < 2) throw new Error('KIND 상장법인 목록 파싱 실패');

  const header = rows[0];
  const nameIdx = header.findIndex((h) => h.includes('회사명'));
  const tickerIdx = header.findIndex((h) => h.includes('종목코드'));
  const indIdx = header.findIndex((h) => h.includes('업종'));
  const prodIdx = header.findIndex((h) => h.includes('주요제품'));

  const companies = [];
  const seen = new Set();

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const rawTicker = (cols[tickerIdx] || '').replace(/\D/g, '');
    if (!rawTicker) continue;
    const ticker = rawTicker.padStart(6, '0');
    if (ticker.length !== 6 || seen.has(ticker)) continue;
    seen.add(ticker);

    companies.push({
      ticker,
      name: cols[nameIdx] || ticker,
      industry: cols[indIdx] || '',
      products: cols[prodIdx] || '',
    });
  }

  console.log(`[1/3] 총 ${companies.length}개 상장법인 데이터 확보 완료`);
  return companies;
}

function fallbackClassify(comp) {
  const text = `${comp.name} ${comp.industry} ${comp.products}`;
  let sectorMain = '기타';
  if (/반도체|웨이퍼|파운드리|메모리|HBM|PCB|인쇄회로/i.test(text)) sectorMain = '반도체';
  else if (/전지|배터리|양극재|음극재|전해질|분리막|리튬/i.test(text)) sectorMain = '2차전지';
  else if (/변압기|전력|전선|원자력|발전|태양광|풍력|에너지/i.test(text)) sectorMain = '전력·에너지';
  else if (/제약|바이오|의약|의료기기|임상|진단|항체|백신/i.test(text)) sectorMain = '바이오·헬스케어';
  else if (/조선|선박|해양|엔진|보냉재/i.test(text)) sectorMain = '조선·해양';
  else if (/방산|항공|우주|위성|유도무기|장갑차|탄약/i.test(text)) sectorMain = '방산·우주';
  else if (/자동차|차량|모빌리티|타이어|자율주행/i.test(text)) sectorMain = '자동차·모빌리티';
  else if (/로봇|자동화|스마트팩토리|협동로봇|감속기/i.test(text)) sectorMain = '로봇·자동화';
  else if (/소프트웨어|AI|인공지능|클라우드|게임|플랫폼|보안|IT서비스/i.test(text)) sectorMain = 'AI·SW·플랫폼';
  else if (/은행|증권|보험|금융|지주|카드|캐피탈/i.test(text)) sectorMain = '금융·지주';
  else if (/화학|석유화학|정밀화학|소재|필름|플라스틱/i.test(text)) sectorMain = '화학·소재';
  else if (/철강|제철|비철|알루미늄|동|아연|구리/i.test(text)) sectorMain = '철강·비철';
  else if (/건설|엔지니어링|시멘트|기계|중장비|굴삭기/i.test(text)) sectorMain = '건설·기계';
  else if (/엔터|음반|방송|미디어|영화|드라마|광고/i.test(text)) sectorMain = '엔터·미디어';
  else if (/식품|화장품|의류|유통|백화점|마트|음료/i.test(text)) sectorMain = '소비재·유통';

  const rawSub = (comp.products || comp.industry || '일반사업').split(',')[0].trim();
  const sectorSub = rawSub.slice(0, 14) || '일반사업';
  const bizSummary = `${comp.industry || sectorMain} 분야 (${(comp.products || comp.name).slice(0, 28)})`;
  return { sectorMain, sectorSub, bizSummary };
}

async function findWorkingGeminiModel(apiKey) {
  console.log('[사전 점검] 사용 가능한 Gemini Flash 모델 탐색 중...');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) {
    throw new Error(`모델 목록 조회 실패 (HTTP ${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const candidates = (data.models || [])
    .filter(
      (m) =>
        (m.supportedGenerationMethods || []).includes('generateContent') &&
        /flash/i.test(m.name) &&
        !/image|audio|tts|live|thinking|001/i.test(m.name)
    )
    .map((m) => m.name)
    .sort((a, b) => b.localeCompare(a));

  for (const modelName of candidates) {
    try {
      const testRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'OK' }] }],
          }),
        }
      );
      if (testRes.ok) {
        console.log(`✅ 모델 연결 확정: ${modelName}`);
        return modelName;
      }
    } catch {}
  }
  throw new Error(`사용 가능한 Flash 모델을 찾지 못했습니다. 후보: ${candidates.join(', ')}`);
}

async function classifyBatchWithGemini(modelName, batch, apiKey) {
  const prompt = `당신은 한국 주식시장 전문 애널리스트입니다. 아래 종목들의 회사명, 업종, 주요제품을 분석해 핵심 사업 라벨을 JSON 배열로 반환하세요.
규칙:
1. sectorMain: 반드시 다음 16개 중 하나만 정확히 선택 -> ${ALLOWED_SECTORS.join(', ')}
2. sectorSub: 회사의 핵심 밸류체인·주력 제품을 12자 이내 명사형으로 구체화 (예: "HBM 본딩장비", "초고압 변압기", "비만치료제·ADC", "LNG선 보냉재", "K-방산 유도무기", "유리기판 소재")
3. bizSummary: 주요 매출원과 시장 지위를 40자 이내 한 줄로 요약

입력 데이터:
${JSON.stringify(batch)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            ticker: { type: 'STRING' },
            sectorMain: { type: 'STRING' },
            sectorSub: { type: 'STRING' },
            bizSummary: { type: 'STRING' },
          },
          required: ['ticker', 'sectorMain', 'sectorSub', 'bizSummary'],
        },
      },
    },
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body,
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        return JSON.parse(text);
      }

      if (res.status === 429) {
        console.warn(`   ⏳ 분당 호출 한도(429) 도달 — 15초 대기 후 재시도 (${attempt}/3)...`);
        await sleep(15000);
        continue;
      }

      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 160)}`);
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`   ⚠️ 응답 지연/오류(${err.message}) — 5초 후 재시도 (${attempt}/3)...`);
      await sleep(5000);
    }
  }
}

try {
  await pool.query('SELECT 1');
  console.log('[사전 점검] PostgreSQL DB 연결 정상');
} catch (err) {
  console.error('❌ PostgreSQL DB 연결 실패! 먼저 "docker start krx-postgres"를 실행하세요:', err.message);
  process.exit(1);
}

const companies = await fetchKindCompanies();

const forceAll = process.argv.includes('--force');
const { rows: existingRows } = await pool.query(
  `SELECT ticker, sector_source FROM stocks WHERE sector_main IS NOT NULL`
);
const aiDoneSet = new Set(
  existingRows.filter((r) => !forceAll && r.sector_source === 'AI').map((r) => r.ticker)
);

const targets = companies.filter((c) => !aiDoneSet.has(c.ticker));
const apiKey = (process.env.GEMINI_API_KEY || '').trim();
const hasValidKey = apiKey.startsWith('AIza') || apiKey.startsWith('AQ.');

let activeModel = null;
if (hasValidKey && targets.length > 0) {
  activeModel = await findWorkingGeminiModel(apiKey);
}

console.log(
  `[2/3] 분류 대상 ${targets.length}종목 (이미 AI 완료: ${aiDoneSet.size}종목) | 모드: ${activeModel ? `Gemini AI (${activeModel})` : '공시 키워드 1차 분류'}`
);

const BATCH_SIZE = 50;
const totalBatches = Math.ceil(targets.length / BATCH_SIZE);

for (let i = 0; i < targets.length; i += BATCH_SIZE) {
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  const batch = targets.slice(i, i + BATCH_SIZE);
  let results = [];
  let source = 'RULE';

  if (activeModel) {
    process.stdout.write(`[3/3] 배치 ${batchNum}/${totalBatches} (${batch.length}종목) AI 분석 중... `);
    try {
      results = await classifyBatchWithGemini(activeModel, batch, apiKey);
      source = 'AI';
      console.log(`완료! (누적 ${Math.min(i + BATCH_SIZE, targets.length)} / ${targets.length})`);
    } catch (err) {
      console.log(`실패 → 1차 규칙 대체 (${err.message})`);
      results = batch.map((c) => ({ ticker: c.ticker, ...fallbackClassify(c) }));
    }
  } else {
    results = batch.map((c) => ({ ticker: c.ticker, ...fallbackClassify(c) }));
    console.log(`[3/3] 저장 진행: ${Math.min(i + BATCH_SIZE, targets.length)} / ${targets.length} (RULE)`);
  }

  const resultMap = new Map(results.map((r) => [String(r.ticker).padStart(6, '0'), r]));

  for (const comp of batch) {
    const tagged = resultMap.get(comp.ticker) || fallbackClassify(comp);
    const safeMain = ALLOWED_SECTORS.includes(tagged.sectorMain) ? tagged.sectorMain : '기타';

    await pool.query(
      `INSERT INTO stocks (ticker, name, market, sector_main, sector_sub, biz_summary, sector_source, sector_updated_at)
       VALUES ($1, $2, 'KRX', $3, $4, $5, $6, NOW())
       ON CONFLICT (ticker) DO UPDATE SET
         name = EXCLUDED.name,
         sector_main = EXCLUDED.sector_main,
         sector_sub = EXCLUDED.sector_sub,
         biz_summary = EXCLUDED.biz_summary,
         sector_source = EXCLUDED.sector_source,
         sector_updated_at = NOW()`,
      [comp.ticker, comp.name, safeMain, tagged.sectorSub.slice(0, 60), tagged.bizSummary.slice(0, 190), source]
    );
  }

  if (activeModel) await sleep(2000);
}

console.log('✅ 전 종목 상세 라벨 DB 적재 완료!');
await pool.end();
