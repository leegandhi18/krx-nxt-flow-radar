import Fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { getKiwoomToken, redis, subRedis } from './authManager.js';
import { pollAllRankings, syncDailyCloseToDb, getMarketSession, pool } from './kiwoomPoller.js';
import * as kisWs from './kisWsClient.js';

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 시간 초과 (${ms / 1000}초) - Docker 컨테이너 상태를 확인하세요`)), ms)
    ),
  ]);
}

const ETF_SPAC_REGEX =
  /^(KODEX|TIGER|KBSTAR|RISE|ACE|SOL|HANARO|KOSEF|ARIRANG|TIMEFOLIO|PLUS|WON|KIWOOM|KOACT|1Q|BNK|FOCUS|TREX)\b|ETF|ETN|레버리지|인버스|스팩\d*호?$|제\d+호스팩$/i;

function isNonCommonStock(name = '') {
  return ETF_SPAC_REGEX.test(name.trim());
}

function parseNum(val) {
  if (val === undefined || val === null || val === '') return 0;
  const cleaned = String(val).replace(/[,+]/g, '').replace(/^--+/, '-').trim();
  const num = Number(cleaned);
  return Number.isNaN(num) ? 0 : num;
}

const sectorCache = new Map();

async function reloadSectorCache() {
  const { rows } = await pool.query(
    'SELECT ticker, sector_main, sector_sub, biz_summary FROM stocks WHERE sector_main IS NOT NULL'
  );
  sectorCache.clear();
  for (const r of rows) {
    sectorCache.set(r.ticker, {
      sectorMain: r.sector_main,
      sectorSub: r.sector_sub,
      bizSummary: r.biz_summary,
    });
  }
  console.log(`[SectorCache] 전 종목 상세 라벨 ${sectorCache.size}건 메모리 로드 완료`);
}

function getStockSector(ticker, name = '') {
  const hit = sectorCache.get(ticker);
  if (hit) return hit;
  if (isNonCommonStock(name)) {
    return {
      sectorMain: 'ETF·스팩',
      sectorSub: /스팩/.test(name) ? '기업인수목적(SPAC)' : 'ETF · 지수/테마',
      bizSummary: '상장지수펀드(ETF/ETN) 또는 스팩(SPAC) 종목',
    };
  }
  return { sectorMain: '기타', sectorSub: '신규·미분류', bizSummary: '' };
}

const tickerBackfillLocks = new Map();

async function ensureTickerDailyHistory(ticker) {
  if (!/^[0-9A-Za-z]{6}$/.test(ticker)) return;
  const { rows: cntRows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM daily_investor_flows WHERE ticker = $1 AND is_finalized = TRUE`,
    [ticker]
  );
  if ((cntRows[0]?.cnt || 0) >= 60) return;

  if (tickerBackfillLocks.has(ticker)) {
    await tickerBackfillLocks.get(ticker);
    return;
  }

  const job = (async () => {
    try {
      const token = await getKiwoomToken();
      const todayIso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const compactToday = todayIso.replace(/-/g, '');
      let contYn = 'N';
      let nextKey = '';
      const rowsToSave = [];

      for (let page = 0; page < 4; page++) {
        const res = await fetch(`${process.env.KIWOOM_BASE_URL}/api/dostk/stkinfo`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            authorization: `Bearer ${token}`,
            'api-id': 'ka10059',
            'cont-yn': contYn,
            'next-key': nextKey,
          },
          body: JSON.stringify({
            dt: compactToday,
            stk_cd: ticker,
            amt_qty_tp: '1',
            trde_tp: '0',
            unit_tp: '1',
          }),
        });

        const data = await res.json();
        if (data?.return_code && data.return_code !== 0) break;

        const listKey = Object.keys(data).find((k) => Array.isArray(data[k]));
        const rawList = listKey ? data[listKey] : [];
        if (!rawList.length) break;

        for (const item of rawList) {
          const rawDt = String(item.dt || '').replace(/\D/g, '');
          if (rawDt.length !== 8) continue;
          const isoDate = `${rawDt.slice(0, 4)}-${rawDt.slice(4, 6)}-${rawDt.slice(6, 8)}`;
          rowsToSave.push({
            tradeDate: isoDate,
            closePrice: Math.abs(parseNum(item.cur_prc)),
            changeRate: parseNum(item.flu_rt),
            foreignNet: parseNum(item.frgnr_invsr),
            instNet: parseNum(item.orgn),
            indivNet: parseNum(item.ind_invsr),
            pensionNet: parseNum(item.penfnd_etc),
            finInvestNet: parseNum(item.fnnc_invt),
            isFinalized: isoDate < todayIso,
          });
        }

        const respCont = (res.headers.get('cont-yn') || '').trim();
        const respNext = (res.headers.get('next-key') || '').trim();
        if (respCont === 'Y' && respNext && rowsToSave.length < 260) {
          contYn = 'Y';
          nextKey = respNext;
          await new Promise((r) => setTimeout(r, 220));
        } else {
          break;
        }
      }

      if (!rowsToSave.length) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO stocks (ticker, name, market, updated_at) VALUES ($1, $1, 'KRX', NOW()) ON CONFLICT (ticker) DO NOTHING`,
          [ticker]
        );
        for (const r of rowsToSave) {
          await client.query(
            `INSERT INTO daily_investor_flows
               (trade_date, ticker, close_price, change_rate, foreign_net_amt, inst_net_amt, indiv_net_amt, pension_net_amt, fin_invest_net_amt, is_finalized, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (trade_date, ticker) DO UPDATE SET
               close_price = CASE WHEN EXCLUDED.close_price > 0 THEN EXCLUDED.close_price ELSE daily_investor_flows.close_price END,
               change_rate = EXCLUDED.change_rate,
               foreign_net_amt = EXCLUDED.foreign_net_amt,
               inst_net_amt = EXCLUDED.inst_net_amt,
               indiv_net_amt = EXCLUDED.indiv_net_amt,
               pension_net_amt = EXCLUDED.pension_net_amt,
               fin_invest_net_amt = EXCLUDED.fin_invest_net_amt,
               is_finalized = EXCLUDED.is_finalized,
               updated_at = NOW()`,
            [r.tradeDate, ticker, r.closePrice, r.changeRate, r.foreignNet, r.instNet, r.indivNet, r.pensionNet, r.finInvestNet, r.isFinalized]
          );
        }
        await client.query('COMMIT');
      } catch (dbErr) {
        await client.query('ROLLBACK');
        throw dbErr;
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn(`[History AutoFill] ${ticker} 경고:`, err.message);
    } finally {
      tickerBackfillLocks.delete(ticker);
    }
  })();

  tickerBackfillLocks.set(ticker, job);
  await job;
}

function analyzeIntradaySignals(points = [], liveTick = null) {
  const signals = [];
  if (!points.length) return signals;
  const first = points[0];
  const last = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;

  if (first.foreignNet < 0 && last.foreignNet > 0) signals.push({ type: 'turn_foreign', label: '🔄 외인 순매수 전환', tone: 'rose' });
  if (first.instNet < 0 && last.instNet > 0) signals.push({ type: 'turn_inst', label: '🔄 기관 순매수 전환', tone: 'amber' });
  if (prev && last.foreignNet - prev.foreignNet > 0 && last.instNet - prev.instNet > 0) {
    signals.push({ type: 'double_inflow', label: '💎 외인·기관 동시 유입중', tone: 'purple' });
  }
  const rate = liveTick?.changeRate ?? last.changeRate ?? 0;
  if (rate <= 0 && last.foreignNet > 0 && last.instNet > 0) {
    signals.push({ type: 'divergence', label: '🛡️ 눌림목 쌍끌이 매집', tone: 'emerald' });
  }
  return signals;
}

let isPolling = false;
async function safePollAllRankings() {
  if (isPolling) return;
  isPolling = true;
  try {
    await pollAllRankings();
  } finally {
    isPolling = false;
  }
}

app.get('/api/health', async () => {
  const redisPing = await redis.ping();
  const dbRes = await pool.query('SELECT NOW() AS now');
  return {
    status: 'ok',
    session: getMarketSession(),
    redis: redisPing,
    postgres: dbRes.rows[0].now,
    cachedSectors: sectorCache.size,
  };
});

app.get('/api/rankings', async () => {
  const keys = ['foreign:buy', 'foreign:sell', 'inst:buy', 'inst:sell', 'indiv:buy', 'indiv:sell'];
  const liveTicksRaw = await redis.hgetall('live:ticks');
  const liveTicks = {};
  for (const [ticker, jsonStr] of Object.entries(liveTicksRaw)) {
    liveTicks[ticker] = JSON.parse(jsonStr);
  }

  const rawBuckets = {};
  for (const k of keys) {
    const raw = await redis.get(`rank:${k}`);
    rawBuckets[k] = raw ? JSON.parse(raw) : { updatedAt: null, items: [] };
  }

  const foreignBuySet = new Set(rawBuckets['foreign:buy'].items.map((i) => i.ticker));
  const instBuySet = new Set(rawBuckets['inst:buy'].items.map((i) => i.ticker));
  const indivBuySet = new Set(rawBuckets['indiv:buy'].items.map((i) => i.ticker));
  const foreignSellSet = new Set(rawBuckets['foreign:sell'].items.map((i) => i.ticker));
  const instSellSet = new Set(rawBuckets['inst:sell'].items.map((i) => i.ticker));
  const indivSellSet = new Set(rawBuckets['indiv:sell'].items.map((i) => i.ticker));

  const rankings = {};
  for (const k of keys) {
    const isBuy = k.endsWith(':buy');
    const parsed = rawBuckets[k];
    const mappedItems = parsed.items.map((item) => {
      const live = liveTicks[item.ticker];
      const resolvedPrice = live?.price || item.price;
      const resolvedAmt =
        item.netAmt !== 0
          ? item.netAmt
          : item.netQty !== 0 && resolvedPrice > 0
          ? Math.round((item.netQty * resolvedPrice) / 1_000_000)
          : 0;
      const isDoubleBuy = foreignBuySet.has(item.ticker) && instBuySet.has(item.ticker);
      const isDoubleSell = foreignSellSet.has(item.ticker) && instSellSet.has(item.ticker);
      return {
        ...item,
        ...getStockSector(item.ticker, item.name),
        netAmt: resolvedAmt,
        price: resolvedPrice,
        changeRate: live?.changeRate ?? item.changeRate,
        strength: live?.strength || 0,
        isLive: Boolean(live),
        isDoubleBuy,
        isDoubleSell,
        isTripleBuy: isDoubleBuy && indivBuySet.has(item.ticker),
        isTripleSell: isDoubleSell && indivSellSet.has(item.ticker),
        isEtfOrSpac: isNonCommonStock(item.name),
      };
    });

    mappedItems.sort((a, b) => (isBuy ? b.netAmt - a.netAmt : a.netAmt - b.netAmt));
    parsed.items = mappedItems.map((item, idx) => ({ ...item, rank: idx + 1 }));
    rankings[k] = parsed;
  }

  return { session: getMarketSession(), rankings };
});

app.get('/api/intraday-flow', async () => {
  const kstDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const [latestRaw, timelineRawList, liveTicksRaw] = await Promise.all([
    redis.get(`intraday:latest:${kstDate}`),
    redis.lrange(`intraday:timeline:${kstDate}`, -240, -1),
    redis.hgetall('live:ticks'),
  ]);

  const latestParsed = latestRaw ? JSON.parse(latestRaw) : { updatedAt: null, stocks: {} };
  const timeline = timelineRawList.map((str) => {
    const p = JSON.parse(str);
    return { time: p.time, totalForeign: p.totalForeign, totalInst: p.totalInst, totalIndiv: p.totalIndiv };
  });

  const sectorMap = new Map();
  const stocks = Object.values(latestParsed.stocks || {})
    .map((s) => {
      const sector = getStockSector(s.ticker, s.name);
      const isEtfOrSpac = isNonCommonStock(s.name);
      const smartMoneyAmt = (s.foreignNet || 0) + (s.instNet || 0);
      const smartMoneyDelta = (s.deltaForeign || 0) + (s.deltaInst || 0);
      const live = liveTicksRaw[s.ticker] ? JSON.parse(liveTicksRaw[s.ticker]) : null;

      if (!isEtfOrSpac && sector.sectorMain !== 'ETF·스팩') {
        const key = sector.sectorMain || '기타';
        if (!sectorMap.has(key)) {
          sectorMap.set(key, { sector: key, count: 0, foreignNet: 0, instNet: 0, indivNet: 0, smartMoneyAmt: 0, smartMoneyDelta: 0 });
        }
        const agg = sectorMap.get(key);
        agg.count += 1;
        agg.foreignNet += s.foreignNet || 0;
        agg.instNet += s.instNet || 0;
        agg.indivNet += s.indivNet || 0;
        agg.smartMoneyAmt += smartMoneyAmt;
        agg.smartMoneyDelta += smartMoneyDelta;
      }

      return {
        ...s,
        ...sector,
        price: live?.price || s.price,
        changeRate: live?.changeRate ?? s.changeRate,
        strength: live?.strength || 0,
        isEtfOrSpac,
        smartMoneyAmt,
        smartMoneyDelta,
      };
    })
    .sort((a, b) => Math.abs(b.smartMoneyAmt) - Math.abs(a.smartMoneyAmt));

  return {
    date: kstDate,
    session: getMarketSession(),
    updatedAt: latestParsed.updatedAt,
    timeline,
    sectorSummary: [...sectorMap.values()].sort((a, b) => Math.abs(b.smartMoneyAmt) - Math.abs(a.smartMoneyAmt)),
    stocks,
  };
});

app.get('/api/intraday-flow/batch', async (req) => {
  const rawTickers = String(req.query.tickers || '').split(',').map((t) => t.trim()).filter((t) => /^[0-9A-Za-z]{6}$/.test(t)).slice(0, 4);
  if (!rawTickers.length) return { items: [] };
  await kisWs.registerPriorityTickers?.(rawTickers);

  const kstDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const [timelineRawList, dbStocks] = await Promise.all([
    redis.lrange(`intraday:timeline:${kstDate}`, -120, -1),
    pool.query('SELECT ticker, name FROM stocks WHERE ticker = ANY($1)', [rawTickers]),
  ]);

  const dbNameMap = new Map(dbStocks.rows.map((r) => [r.ticker, r.name]));
  const parsedTimeline = timelineRawList.map((str) => JSON.parse(str));

  const items = await Promise.all(
    rawTickers.map(async (ticker) => {
      const liveRaw = await redis.hget('live:ticks', ticker);
      const liveTick = liveRaw ? JSON.parse(liveRaw) : null;
      let stockName = dbNameMap.get(ticker) || ticker;
      const points = [];
      for (const p of parsedTimeline) {
        const arr = p.stocks?.[ticker];
        if (!arr) continue;
        if (arr[5]) stockName = arr[5];
        points.push({ time: p.time, foreignNet: arr[0] || 0, instNet: arr[1] || 0, indivNet: arr[2] || 0, price: arr[3] || 0, changeRate: arr[4] || 0 });
      }
      return { ticker, name: stockName, ...getStockSector(ticker, stockName), liveTick, signals: analyzeIntradaySignals(points, liveTick), points };
    })
  );

  return { date: kstDate, items };
});

app.get('/api/intraday-flow/:ticker', async (req) => {
  const { ticker } = req.params;
  await kisWs.registerPriorityTickers?.([ticker]);

  const kstDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const [timelineRawList, stockRow, liveRaw] = await Promise.all([
    redis.lrange(`intraday:timeline:${kstDate}`, 0, -1),
    pool.query('SELECT name FROM stocks WHERE ticker = $1', [ticker]),
    redis.hget('live:ticks', ticker),
  ]);

  const liveTick = liveRaw ? JSON.parse(liveRaw) : null;
  let stockName = stockRow.rows[0]?.name || ticker;
  const points = [];
  for (const str of timelineRawList) {
    const p = JSON.parse(str);
    const arr = p.stocks?.[ticker];
    if (!arr) continue;
    if (arr[5]) stockName = arr[5];
    points.push({ time: p.time, foreignNet: arr[0] || 0, instNet: arr[1] || 0, indivNet: arr[2] || 0, price: arr[3] || 0, changeRate: arr[4] || 0 });
  }

  return { date: kstDate, ticker, name: stockName, ...getStockSector(ticker, stockName), liveTick, signals: analyzeIntradaySignals(points, liveTick), points };
});

app.get('/api/consecutive', async (req) => {
  const days = Math.min(Math.max(Number(req.query.days || 3), 1), 30);
  const investor = req.query.investor || 'foreign';
  let condition = 'f.foreign_net_amt > 0';
  let sumExpr = 'SUM(r.foreign_net_amt)';
  if (investor === 'inst') {
    condition = 'f.inst_net_amt > 0';
    sumExpr = 'SUM(r.inst_net_amt)';
  } else if (investor === 'both') {
    condition = 'f.foreign_net_amt > 0 AND f.inst_net_amt > 0';
    sumExpr = 'SUM(r.foreign_net_amt + r.inst_net_amt)';
  }

  const sql = `
    WITH recent_dates AS (
      SELECT DISTINCT trade_date FROM daily_investor_flows ORDER BY trade_date DESC LIMIT $1
    ),
    target_days AS (SELECT COUNT(*)::int AS avail_days FROM recent_dates),
    ranked AS (
      SELECT f.ticker, s.name, f.trade_date, f.close_price, f.change_rate, f.foreign_net_amt, f.inst_net_amt, f.indiv_net_amt,
             ROW_NUMBER() OVER (PARTITION BY f.ticker ORDER BY f.trade_date DESC) AS rn
      FROM daily_investor_flows f
      JOIN stocks s ON s.ticker = f.ticker
      WHERE f.trade_date IN (SELECT trade_date FROM recent_dates) AND ${condition}
    )
    SELECT r.ticker, MAX(r.name) AS name, COUNT(*)::int AS streak_days,
           MAX(CASE WHEN r.rn = 1 THEN r.close_price END) AS close_price,
           MAX(CASE WHEN r.rn = 1 THEN r.change_rate END) AS change_rate,
           SUM(r.foreign_net_amt)::bigint AS total_foreign_amt,
           SUM(r.inst_net_amt)::bigint AS total_inst_amt,
           ${sumExpr}::bigint AS sort_amt
    FROM ranked r
    GROUP BY r.ticker
    HAVING COUNT(*) >= LEAST($1, (SELECT avail_days FROM target_days)) AND (SELECT avail_days FROM target_days) > 0
    ORDER BY sort_amt DESC
    LIMIT 100
  `;

  const [{ rows }, { rows: totalDateRows }] = await Promise.all([
    pool.query(sql, [days]),
    pool.query('SELECT COUNT(DISTINCT trade_date)::int AS total_days FROM daily_investor_flows'),
  ]);

  return {
    requestedDays: days,
    availableDbDays: totalDateRows[0]?.total_days ?? 0,
    investor,
    items: rows.map((r) => ({ ...r, ...getStockSector(r.ticker, r.name), isEtfOrSpac: isNonCommonStock(r.name) })),
  };
});

app.get('/api/stocks/:ticker/history', async (req) => {
  const { ticker } = req.params;
  await ensureTickerDailyHistory(ticker);
  const { rows } = await pool.query(
    `SELECT trade_date, close_price, change_rate, foreign_net_amt, inst_net_amt, indiv_net_amt, pension_net_amt, fin_invest_net_amt, is_finalized
     FROM daily_investor_flows WHERE ticker = $1 ORDER BY trade_date ASC LIMIT 365`,
    [ticker]
  );
  return { ticker, history: rows };
});

app.patch('/api/stocks/:ticker/sector', async (req) => {
  const { ticker } = req.params;
  const { sectorMain, sectorSub, bizSummary } = req.body || {};
  await pool.query(
    `UPDATE stocks SET sector_main = COALESCE($2, sector_main), sector_sub = COALESCE($3, sector_sub), biz_summary = COALESCE($4, biz_summary), sector_source = 'MANUAL', sector_updated_at = NOW() WHERE ticker = $1`,
    [ticker, sectorMain || null, sectorSub || null, bizSummary || null]
  );
  await reloadSectorCache();
  return { ok: true, sector: sectorCache.get(ticker) };
});

app.post('/api/admin/sync-close', async () => {
  await safePollAllRankings();
  await syncDailyCloseToDb(true);
  return { ok: true };
});

const sseClients = new Set();
console.log('[Boot 1/4] Redis Pub/Sub 구독 연결 중...');
await withTimeout(subRedis.subscribe('channel:rank_update', 'channel:tick_update'), 5000, 'Redis 구독');

subRedis.on('message', (channel, message) => {
  const eventName = channel === 'channel:rank_update' ? 'rank_update' : 'tick_update';
  const frame = `event: ${eventName}\ndata: ${message}\n\n`;
  for (const res of sseClients) res.write(frame);
});

app.get('/api/stream', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  reply.raw.write(`event: connected\ndata: {"session":"${getMarketSession()}"}\n\n`);
  sseClients.add(reply.raw);
  req.raw.on('close', () => sseClients.delete(reply.raw));
});

setInterval(async () => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return;
  const hhmm = now.getHours() * 100 + now.getMinutes();
  if (hhmm >= 800 && hhmm <= 2010) await safePollAllRankings();
}, 20_000);

setInterval(async () => {
  if (getMarketSession() !== 'CLOSED') await kisWs.syncWsSubscriptions?.();
}, 30_000);

cron.schedule('*/5 8-20 * * 1-5', async () => { await syncDailyCloseToDb(false); }, { timezone: 'Asia/Seoul' });
cron.schedule('42 15 * * 1-5', async () => { await safePollAllRankings(); await syncDailyCloseToDb(false); }, { timezone: 'Asia/Seoul' });
cron.schedule('6 20 * * 1-5', async () => { await safePollAllRankings(); await syncDailyCloseToDb(true); }, { timezone: 'Asia/Seoul' });
cron.schedule('30 20 * * 1-5', async () => { await safePollAllRankings(); await syncDailyCloseToDb(true); }, { timezone: 'Asia/Seoul' });

const PORT = Number(process.env.PORT || 4000);
console.log('[Boot 2/4] PostgreSQL 상세 섹터 라벨 로딩 중...');
await withTimeout(reloadSectorCache(), 5000, 'PostgreSQL 섹터 로드');

console.log('[Boot 3/4] Fastify HTTP 서버 바인딩 중...');
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Server] API & SSE 서버 가동 완료 → http://localhost:${PORT}`);

console.log('[Boot 4/4] 초기 수급 수집 및 실시간 WebSocket 연결 중...');
await safePollAllRankings();
await syncDailyCloseToDb(false);
await kisWs.startKisWebSocket?.();
