import pg from 'pg';
import { getKiwoomToken, redis, pubRedis, subRedis } from '../src/authManager.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TARGET_TRADING_DAYS = Math.min(Math.max(Number(process.argv[2] || 250), 1), 300);

function parseNum(val) {
  if (val === undefined || val === null || val === '') return 0;
  const cleaned = String(val).replace(/[,+]/g, '').replace(/^--+/, '-').trim();
  const num = Number(cleaned);
  return Number.isNaN(num) ? 0 : num;
}

function extractNetMetric(item) {
  const keys = Object.keys(item);
  const amtKey =
    keys.find((k) => /(net|prps|slmt)/i.test(k) && /(amt|prica)/i.test(k) && parseNum(item[k]) !== 0) ||
    keys.find((k) => /(net|prps|slmt)/i.test(k) && /(amt|prica)/i.test(k));
  const qtyKey =
    keys.find((k) => /(netprps|netslmt|net_qty)/i.test(k) && parseNum(item[k]) !== 0) ||
    keys.find((k) => /(netprps|netslmt|net_qty)/i.test(k));
  return {
    netAmt: amtKey ? parseNum(item[amtKey]) : 0,
    netQty: qtyKey ? parseNum(item[qtyKey]) : 0,
  };
}

async function fetchKa10058(compactDate, invsrTp, mrktTp, isBuy, maxItems = 100) {
  const token = await getKiwoomToken();
  const trdeTp = isBuy ? '2' : '1';
  const sign = isBuy ? 1 : -1;
  const collected = [];
  const seen = new Set();
  let contYn = 'N';
  let nextKey = '';

  for (let page = 0; page < 4 && collected.length < maxItems; page++) {
    let res;
    let data;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetch(`${process.env.KIWOOM_BASE_URL}/api/dostk/stkinfo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          authorization: `Bearer ${token}`,
          'api-id': 'ka10058',
          'cont-yn': contYn,
          'next-key': nextKey,
        },
        body: JSON.stringify({
          strt_dt: compactDate,
          end_dt: compactDate,
          trde_tp: trdeTp,
          mrkt_tp: mrktTp,
          invsr_tp: invsrTp,
          stex_tp: '3',
        }),
      });
      if (res.status === 429) {
        await sleep(1500 * attempt);
        continue;
      }
      data = await res.json();
      await sleep(230);
      if (data?.return_code && data.return_code !== 0 && String(data.return_msg || '').includes('초과')) {
        await sleep(1500 * attempt);
        continue;
      }
      break;
    }

    if (!data || (data.return_code && data.return_code !== 0)) break;
    const listKey = Object.keys(data).find((k) => Array.isArray(data[k]));
    const rawList = listKey ? data[listKey] : [];
    if (!rawList.length) break;

    for (const item of rawList) {
      if (collected.length >= maxItems) break;
      const ticker = String(item.stk_cd || '').replace(/^A/, '').split('_')[0].trim();
      if (ticker.length !== 6 || seen.has(ticker)) continue;
      seen.add(ticker);

      const price = Math.abs(parseNum(item.cur_prc ?? item.close_pric));
      const changeRate = parseNum(item.flu_rt ?? item.pre_rt);
      let { netAmt, netQty } = extractNetMetric(item);
      netAmt = sign > 0 ? Math.abs(netAmt) : -Math.abs(netAmt);
      netQty = sign > 0 ? Math.abs(netQty) : -Math.abs(netQty);
      if (netAmt === 0 && netQty !== 0 && price > 0) {
        netAmt = Math.round((netQty * price) / 1_000_000);
      }
      collected.push({ ticker, name: (item.stk_nm || '').trim(), price, changeRate, netAmt });
    }

    const respContYn = (res?.headers?.get('cont-yn') || '').trim();
    const respNextKey = (res?.headers?.get('next-key') || '').trim();
    if (respContYn === 'Y' && respNextKey && collected.length < maxItems) {
      contYn = 'Y';
      nextKey = respNextKey;
    } else {
      break;
    }
  }
  return collected;
}

async function fetchSideBothMarkets(compactDate, invsrTp) {
  const map = new Map();
  for (const isBuy of [true, false]) {
    for (const mrkt of ['001', '101']) {
      const list = await fetchKa10058(compactDate, invsrTp, mrkt, isBuy, 100);
      for (const it of list) {
        const prev = map.get(it.ticker);
        if (!prev || Math.abs(it.netAmt) > Math.abs(prev.netAmt)) {
          map.set(it.ticker, it);
        }
      }
    }
  }
  return map;
}

async function backfillOneDate(isoDate) {
  const compactDate = isoDate.replace(/-/g, '');
  const stockMap = new Map();
  const ensureStock = (it) => {
    if (!stockMap.has(it.ticker)) {
      stockMap.set(it.ticker, {
        ticker: it.ticker,
        name: it.name,
        price: it.price,
        changeRate: it.changeRate,
        foreignNet: 0,
        instNet: 0,
        indivNet: 0,
      });
    }
    const row = stockMap.get(it.ticker);
    if (!row.price && it.price) row.price = it.price;
    if (!row.changeRate && it.changeRate) row.changeRate = it.changeRate;
    return row;
  };

  const foreignMap = await fetchSideBothMarkets(compactDate, '9000');
  if (foreignMap.size === 0) return 0;
  for (const it of foreignMap.values()) ensureStock(it).foreignNet = it.netAmt;

  for (const code of ['1000', '3000', '3100', '6000', '2000']) {
    const deskMap = await fetchSideBothMarkets(compactDate, code);
    for (const it of deskMap.values()) ensureStock(it).instNet += it.netAmt;
  }

  const indivMap = await fetchSideBothMarkets(compactDate, '8000');
  for (const it of indivMap.values()) ensureStock(it).indivNet = it.netAmt;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of stockMap.values()) {
      await client.query(
        `INSERT INTO stocks (ticker, name, market, updated_at)
         VALUES ($1, $2, 'KRX', NOW())
         ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
        [s.ticker, s.name]
      );
      await client.query(
        `INSERT INTO daily_investor_flows
           (trade_date, ticker, close_price, change_rate, foreign_net_amt, inst_net_amt, indiv_net_amt, is_finalized, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
         ON CONFLICT (trade_date, ticker) DO UPDATE SET
           close_price = CASE WHEN EXCLUDED.close_price > 0 THEN EXCLUDED.close_price ELSE daily_investor_flows.close_price END,
           change_rate = EXCLUDED.change_rate,
           foreign_net_amt = CASE WHEN EXCLUDED.foreign_net_amt <> 0 THEN EXCLUDED.foreign_net_amt ELSE daily_investor_flows.foreign_net_amt END,
           inst_net_amt = CASE WHEN EXCLUDED.inst_net_amt <> 0 THEN EXCLUDED.inst_net_amt ELSE daily_investor_flows.inst_net_amt END,
           indiv_net_amt = CASE WHEN EXCLUDED.indiv_net_amt <> 0 THEN EXCLUDED.indiv_net_amt ELSE daily_investor_flows.indiv_net_amt END,
           is_finalized = TRUE,
           updated_at = NOW()`,
        [isoDate, s.ticker, s.price, s.changeRate, s.foreignNet, s.instNet, s.indivNet]
      );
    }
    await client.query('COMMIT');
    return stockMap.size;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const { rows: doneRows } = await pool.query(
  `SELECT DISTINCT to_char(trade_date, 'YYYY-MM-DD') AS d FROM daily_investor_flows WHERE is_finalized = TRUE`
);
const doneSet = new Set(doneRows.map((r) => r.d));
console.log(`과거 영업일 수급 데이터 소급 적재 시작 (목표: 최근 ${TARGET_TRADING_DAYS}영업일)...`);

let collectedDays = 0;
const cursor = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));

for (let back = 1; back <= 430 && collectedDays < TARGET_TRADING_DAYS; back++) {
  const d = new Date(cursor);
  d.setDate(cursor.getDate() - back);
  if (d.getDay() === 0 || d.getDay() === 6) continue;
  const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  if (doneSet.has(isoDate)) {
    collectedDays += 1;
    console.log(`[${collectedDays}/${TARGET_TRADING_DAYS}] ${isoDate} — 이미 확정 데이터 존재 (건너뜀)`);
    continue;
  }
  process.stdout.write(`[${collectedDays + 1}/${TARGET_TRADING_DAYS}] ${isoDate} 수집 중... `);
  const count = await backfillOneDate(isoDate);
  if (count === 0) {
    console.log('휴장일 (건너뜀)');
  } else {
    collectedDays += 1;
    console.log(`완료 (${count}종목 DB 저장)`);
  }
}

console.log(`✅ 과거 ${collectedDays}영업일 수급 데이터 적재 완료!`);
redis.disconnect();
pubRedis.disconnect();
subRedis.disconnect();
await pool.end();
