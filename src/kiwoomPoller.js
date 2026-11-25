import pg from 'pg';
import { getKiwoomToken, getKisToken, redis, pubRedis } from './authManager.js';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 키움 REST API 초당 호출 제한(TPS) 방어용 직렬 속도 제어 큐 (최소 220ms 간격 보장)
let kiwoomQueue = Promise.resolve();
function scheduleKiwoomRequest(fn) {
  const next = kiwoomQueue.then(async () => {
    const res = await fn();
    await sleep(220);
    return res;
  });
  kiwoomQueue = next.catch(() => {});
  return next;
}

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

  const netAmt = amtKey ? parseNum(item[amtKey]) : 0;
  const netQty = qtyKey ? parseNum(item[qtyKey]) : 0;
  return { netAmt, netQty };
}

export function getMarketSession() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return 'CLOSED';

  const hhmm = now.getHours() * 100 + now.getMinutes();
  if (hhmm >= 800 && hhmm < 850) return 'PRE_MARKET';
  if (hhmm >= 850 && hhmm < 900) return 'PRE_OPEN_AUCTION';
  if (hhmm >= 900 && hhmm < 1530) return 'REGULAR';
  if (hhmm >= 1530 && hhmm < 1540) return 'POST_CLOSE_AUCTION';
  if (hhmm >= 1540 && hhmm < 2000) return 'AFTER_MARKET';
  return 'CLOSED';
}

async function callKiwoomApi(apiId, path, payload, forceSign = 0, maxItems = 100) {
  const token = await getKiwoomToken();
  const collected = [];
  const seen = new Set();

  let contYn = 'N';
  let nextKey = '';
  let page = 0;

  while (page < 4 && collected.length < maxItems) {
    const { data, respContYn, respNextKey } = await scheduleKiwoomRequest(async () => {
      const res = await fetch(`${process.env.KIWOOM_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          authorization: `Bearer ${token}`,
          'api-id': apiId,
          'cont-yn': contYn,
          'next-key': nextKey,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      return {
        data: json,
        respContYn: (res.headers.get('cont-yn') || '').trim(),
        respNextKey: (res.headers.get('next-key') || '').trim(),
      };
    });

    if (data.return_code && data.return_code !== 0) {
      if (page === 0) {
        console.warn(`[Kiwoom ${apiId}] 응답 메시지:`, data.return_msg || data);
      }
      break;
    }

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

      if (forceSign > 0) {
        netAmt = Math.abs(netAmt);
        netQty = Math.abs(netQty);
      } else if (forceSign < 0) {
        netAmt = -Math.abs(netAmt);
        netQty = -Math.abs(netQty);
      }

      collected.push({
        rank: collected.length + 1,
        ticker,
        name: (item.stk_nm || '').trim(),
        price,
        changeRate,
        netAmt,
        netQty,
        hasExactAmt: netAmt !== 0,
      });
    }

    if (respContYn === 'Y' && respNextKey && collected.length < maxItems) {
      contYn = 'Y';
      nextKey = respNextKey;
      page += 1;
    } else {
      break;
    }
  }

  return collected;
}

async function fetchInvestorByAmount(kstCompactDate, invsrTp, isBuy, maxItems = 100) {
  const trdeTp = isBuy ? '2' : '1';
  const sign = isBuy ? 1 : -1;
  const [kospi, kosdaq] = await Promise.all([
    callKiwoomApi(
      'ka10058',
      '/api/dostk/stkinfo',
      {
        strt_dt: kstCompactDate,
        end_dt: kstCompactDate,
        trde_tp: trdeTp,
        mrkt_tp: '001',
        invsr_tp: invsrTp,
        stex_tp: '3',
      },
      sign,
      maxItems
    ),
    callKiwoomApi(
      'ka10058',
      '/api/dostk/stkinfo',
      {
        strt_dt: kstCompactDate,
        end_dt: kstCompactDate,
        trde_tp: trdeTp,
        mrkt_tp: '101',
        invsr_tp: invsrTp,
        stex_tp: '3',
      },
      sign,
      maxItems
    ),
  ]);
  return [...kospi, ...kosdaq];
}

async function fetchInstitutionalAggregated(kstCompactDate) {
  const instCodes = ['1000', '3000', '3100', '6000', '2000'];
  const aggMap = new Map();

  for (const code of instCodes) {
    const [buyList, sellList] = await Promise.all([
      fetchInvestorByAmount(kstCompactDate, code, true, 100),
      fetchInvestorByAmount(kstCompactDate, code, false, 100),
    ]);

    const deskMap = new Map();
    for (const it of [...buyList, ...sellList]) {
      const prev = deskMap.get(it.ticker);
      if (!prev || Math.abs(it.netAmt) > Math.abs(prev.netAmt)) {
        deskMap.set(it.ticker, it);
      }
    }

    for (const it of deskMap.values()) {
      const cur = aggMap.get(it.ticker) || {
        rank: 0,
        ticker: it.ticker,
        name: it.name,
        price: it.price,
        changeRate: it.changeRate,
        netAmt: 0,
        netQty: 0,
        hasExactAmt: true,
      };
      cur.netAmt += it.netAmt;
      cur.netQty += it.netQty;
      if (!cur.price && it.price) cur.price = it.price;
      if (!cur.changeRate && it.changeRate) cur.changeRate = it.changeRate;
      aggMap.set(it.ticker, cur);
    }
  }

  const buy = [];
  const sell = [];
  for (const item of aggMap.values()) {
    if (item.netAmt > 0) buy.push(item);
    else if (item.netAmt < 0) sell.push(item);
  }
  return { buy, sell };
}

function reconcileInvestorSide(exactBuy = [], exactSell = [], fallbackBuy = [], fallbackSell = []) {
  const netMap = new Map();

  for (const it of [...exactBuy, ...exactSell]) {
    const prev = netMap.get(it.ticker);
    if (!prev || Math.abs(it.netAmt) > Math.abs(prev.netAmt)) {
      netMap.set(it.ticker, { ...it, isExact: true });
    }
  }

  for (const it of [...fallbackBuy, ...fallbackSell]) {
    const prev = netMap.get(it.ticker);
    if (!prev) {
      netMap.set(it.ticker, { ...it, isExact: false });
    } else if (prev.isExact) {
      if (!prev.netQty && it.netQty && Math.sign(prev.netAmt) === Math.sign(it.netQty)) {
        prev.netQty = it.netQty;
      }
    } else {
      const prevScore = Math.abs(prev.netAmt) || Math.abs(prev.netQty);
      const currScore = Math.abs(it.netAmt) || Math.abs(it.netQty);
      if (currScore > prevScore) {
        netMap.set(it.ticker, { ...it, isExact: false });
      }
    }
  }

  const buy = [];
  const sell = [];
  for (const item of netMap.values()) {
    const indicator = item.netAmt !== 0 ? item.netAmt : item.netQty;
    if (indicator > 0) buy.push(item);
    else if (indicator < 0) sell.push(item);
  }
  return { buy, sell };
}

async function hydrateStockPrices(tickers) {
  const priceMap = new Map();
  const cachedTicks = await redis.hgetall('live:ticks');
  for (const [ticker, jsonStr] of Object.entries(cachedTicks)) {
    try {
      priceMap.set(ticker, JSON.parse(jsonStr));
    } catch {}
  }

  if (!tickers.length) return priceMap;

  const missing = tickers.filter((t) => !priceMap.has(t));
  const existingSorted = tickers
    .filter((t) => priceMap.has(t))
    .sort((a, b) => (priceMap.get(a)?.ts || 0) - (priceMap.get(b)?.ts || 0));

  const batch = [...missing, ...existingSorted].slice(0, 45);
  if (!batch.length) return priceMap;

  try {
    const kisToken = await getKisToken();
    for (const ticker of batch) {
      const url = `${process.env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}`;
      const res = await fetch(url, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${kisToken}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
      });
      const data = await res.json();
      const out = data?.output;
      if (out && Number(out.stck_prpr) > 0) {
        const tick = {
          ticker,
          price: Math.abs(Number(out.stck_prpr)),
          changeRate: Number(out.prdy_ctrt || 0),
          ts: Date.now(),
        };
        priceMap.set(ticker, tick);
        await redis.hset('live:ticks', ticker, JSON.stringify(tick));
      }
      await sleep(75);
    }
  } catch (err) {
    console.warn('[Price Hydrate] 시세 보완 중 경고:', err.message);
  }
  return priceMap;
}

async function attachRankDiffAndSave(rankKey, updatedAt, items) {
  const prevHashKey = `rank:prev:${rankKey}`;
  const prevMap = await redis.hgetall(prevHashKey);
  const hasPrev = Object.keys(prevMap).length > 0;

  const enriched = items.map((item, idx) => {
    const rank = idx + 1;
    const prevRankStr = prevMap[item.ticker];
    let rankDiff = 0;
    let isNew = false;

    if (hasPrev) {
      if (!prevRankStr) {
        isNew = true;
      } else {
        rankDiff = Number(prevRankStr) - rank;
      }
    }
    return { ...item, rank, rankDiff, isNew };
  });

  const payload = { updatedAt, items: enriched };
  await redis.set(`rank:${rankKey}`, JSON.stringify(payload));

  if (enriched.length > 0) {
    const nextHash = {};
    for (const it of enriched) {
      nextHash[it.ticker] = String(it.rank);
    }
    await redis.del(prevHashKey);
    await redis.hset(prevHashKey, nextHash);
  }

  return payload;
}

export async function pollAllRankings() {
  const kstCompactDate = new Date()
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
    .replace(/-/g, '');

  const rawBuckets = {};

  try {
    const [fDayBuy, fLiveBuy] = await Promise.all([
      fetchInvestorByAmount(kstCompactDate, '9000', true, 100),
      callKiwoomApi('ka10065', '/api/dostk/rkinfo', { trde_tp: '1', mrkt_tp: '000', orgn_tp: '9000', amt_qty_tp: '0', stex_tp: '3' }, 1, 100),
    ]);
    const [fDaySell, fLiveSell] = await Promise.all([
      fetchInvestorByAmount(kstCompactDate, '9000', false, 100),
      callKiwoomApi('ka10065', '/api/dostk/rkinfo', { trde_tp: '2', mrkt_tp: '000', orgn_tp: '9000', amt_qty_tp: '0', stex_tp: '3' }, -1, 100),
    ]);
    const foreignReconciled = reconcileInvestorSide(fDayBuy, fDaySell, fLiveBuy, fLiveSell);
    rawBuckets['foreign:buy'] = foreignReconciled.buy;
    rawBuckets['foreign:sell'] = foreignReconciled.sell;

    const instExact = await fetchInstitutionalAggregated(kstCompactDate);
    const [iKospiBuy, iKosdaqBuy] = await Promise.all([
      callKiwoomApi('ka10065', '/api/dostk/rkinfo', { trde_tp: '1', mrkt_tp: '001', orgn_tp: '9999', amt_qty_tp: '0', stex_tp: '3' }, 1, 100),
      callKiwoomApi('ka10065', '/api/dostk/rkinfo', { trde_tp: '1', mrkt_tp: '101', orgn_tp: '9999', amt_qty_tp: '0', stex_tp: '3' }, 1, 100),
    ]);
    const [iKospiSell, iKosdaqSell] = await Promise.all([
      callKiwoomApi('ka10065', '/api/dostk/rkinfo', { trde_tp: '2', mrkt_tp: '001', orgn_tp: '9999', amt_qty_tp: '0', stex_tp: '3' }, -1, 100),
      callKiwoomApi('ka10065', '/api/dostk/rkinfo', { trde_tp: '2', mrkt_tp: '101', orgn_tp: '9999', amt_qty_tp: '0', stex_tp: '3' }, -1, 100),
    ]);
    const instReconciled = reconcileInvestorSide(
      instExact.buy,
      instExact.sell,
      [...iKospiBuy, ...iKosdaqBuy],
      [...iKospiSell, ...iKosdaqSell]
    );
    rawBuckets['inst:buy'] = instReconciled.buy;
    rawBuckets['inst:sell'] = instReconciled.sell;

    const [pAmtBuy, pAmtSell] = await Promise.all([
      fetchInvestorByAmount(kstCompactDate, '8000', true, 100),
      fetchInvestorByAmount(kstCompactDate, '8000', false, 100),
    ]);
    const indivReconciled = reconcileInvestorSide(pAmtBuy, pAmtSell, [], []);
    rawBuckets['indiv:buy'] = indivReconciled.buy;
    rawBuckets['indiv:sell'] = indivReconciled.sell;
  } catch (err) {
    console.error('[Poller] 수집 중 오류:', err.message);
  }

  if (!rawBuckets['indiv:buy']?.length) {
    const netMap = new Map();
    for (const k of ['foreign:buy', 'foreign:sell', 'inst:buy', 'inst:sell']) {
      for (const it of rawBuckets[k] || []) {
        const cur = netMap.get(it.ticker) || { ...it, netAmt: 0, netQty: 0 };
        cur.netAmt += it.netAmt;
        cur.netQty += it.netQty;
        netMap.set(it.ticker, cur);
      }
    }
    const indivAll = [...netMap.values()].map((it) => ({
      ...it,
      netAmt: -it.netAmt,
      netQty: -it.netQty,
    }));
    rawBuckets['indiv:buy'] = indivAll.filter((x) => x.netAmt > 0 || x.netQty > 0);
    rawBuckets['indiv:sell'] = indivAll.filter((x) => x.netAmt < 0 || x.netQty < 0);
  }

  const allTickers = new Set();
  for (const k of Object.keys(rawBuckets)) {
    (rawBuckets[k] || []).forEach((it) => allTickers.add(it.ticker));
  }
  const priceMap = await hydrateStockPrices([...allTickers]);

  const updatedAt = new Date().toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const results = {};
  for (const k of Object.keys(rawBuckets)) {
    const isBuy = k.endsWith(':buy');
    const hydrated = (rawBuckets[k] || []).map((it) => {
      const live = priceMap.get(it.ticker);
      const price = live?.price || it.price;
      const changeRate = live?.changeRate ?? it.changeRate;
      let netAmt = it.netAmt;
      if (!it.hasExactAmt && netAmt === 0 && it.netQty !== 0 && price > 0) {
        netAmt = Math.round((it.netQty * price) / 1_000_000);
      }
      return { ...it, price, changeRate, netAmt };
    });

    const sorted = hydrated
      .filter((it) => (isBuy ? it.netAmt > 0 : it.netAmt < 0))
      .sort((a, b) => (isBuy ? b.netAmt - a.netAmt : a.netAmt - b.netAmt))
      .slice(0, 100);

    results[k] = await attachRankDiffAndSave(k, updatedAt, sorted);
  }

  await pubRedis.publish('channel:rank_update', JSON.stringify({ updatedAt, session: getMarketSession() }));
  console.log(
    `[Poller] TPS 안전 큐 수집 완료 (${updatedAt}) | 외인 ${results['foreign:buy']?.items.length || 0} / 기관 ${results['inst:buy']?.items.length || 0} / 개인 ${results['indiv:buy']?.items.length || 0}`
  );
  return results;
}

export async function syncDailyCloseToDb(isFinalized = false) {
  const kstDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const liveTicksRaw = await redis.hgetall('live:ticks');
  const stockMap = new Map();

  const keys = ['foreign:buy', 'foreign:sell', 'inst:buy', 'inst:sell', 'indiv:buy', 'indiv:sell'];
  for (const k of keys) {
    const raw = await redis.get(`rank:${k}`);
    if (!raw) continue;
    const { items } = JSON.parse(raw);

    for (const item of items) {
      const live = liveTicksRaw[item.ticker] ? JSON.parse(liveTicksRaw[item.ticker]) : null;
      if (!stockMap.has(item.ticker)) {
        stockMap.set(item.ticker, {
          ticker: item.ticker,
          name: item.name,
          price: live?.price || item.price,
          changeRate: live?.changeRate ?? item.changeRate,
          foreignNet: 0,
          instNet: 0,
          indivNet: 0,
        });
      }
      const row = stockMap.get(item.ticker);
      if (k.startsWith('foreign:')) row.foreignNet = item.netAmt;
      if (k.startsWith('inst:')) row.instNet = item.netAmt;
      if (k.startsWith('indiv:')) row.indivNet = item.netAmt;
    }
  }

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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (trade_date, ticker) DO UPDATE SET
           close_price = CASE WHEN EXCLUDED.close_price > 0 THEN EXCLUDED.close_price ELSE daily_investor_flows.close_price END,
           change_rate = EXCLUDED.change_rate,
           foreign_net_amt = CASE WHEN EXCLUDED.foreign_net_amt <> 0 THEN EXCLUDED.foreign_net_amt ELSE daily_investor_flows.foreign_net_amt END,
           inst_net_amt = CASE WHEN EXCLUDED.inst_net_amt <> 0 THEN EXCLUDED.inst_net_amt ELSE daily_investor_flows.inst_net_amt END,
           indiv_net_amt = CASE WHEN EXCLUDED.indiv_net_amt <> 0 THEN EXCLUDED.indiv_net_amt ELSE daily_investor_flows.indiv_net_amt END,
           is_finalized = EXCLUDED.is_finalized,
           updated_at = NOW()`,
        [kstDate, s.ticker, s.price, s.changeRate, s.foreignNet, s.instNet, s.indivNet, isFinalized]
      );
    }
    await client.query('COMMIT');
    console.log(`[DB] ${kstDate} 누적 수급 ${stockMap.size}종목 UPSERT 완료 (확정여부: ${isFinalized})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] UPSERT 실패:', err.message);
  } finally {
    client.release();
  }
}
