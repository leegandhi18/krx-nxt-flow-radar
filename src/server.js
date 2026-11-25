import Fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { redis, subRedis } from './authManager.js';
import { pollAllRankings, syncDailyCloseToDb, getMarketSession, pool } from './kiwoomPoller.js';
import { startKisWebSocket, syncWsSubscriptions } from './kisWsClient.js';

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

const ETF_SPAC_REGEX =
  /^(KODEX|TIGER|KBSTAR|RISE|ACE|SOL|HANARO|KOSEF|ARIRANG|TIMEFOLIO|PLUS|WON|KIWOOM|KOACT|1Q|BNK|FOCUS|TREX)\b|ETF|ETN|레버리지|인버스|스팩\d*호?$|제\d+호스팩$/i;

function isNonCommonStock(name = '') {
  return ETF_SPAC_REGEX.test(name.trim());
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

  const foreignBuySet = new Set(rawBuckets['foreign:buy'].items.filter((i) => i.netAmt > 0).map((i) => i.ticker));
  const instBuySet = new Set(rawBuckets['inst:buy'].items.filter((i) => i.netAmt > 0).map((i) => i.ticker));
  const indivBuySet = new Set(rawBuckets['indiv:buy'].items.filter((i) => i.netAmt > 0).map((i) => i.ticker));

  const foreignSellSet = new Set(rawBuckets['foreign:sell'].items.filter((i) => i.netAmt < 0).map((i) => i.ticker));
  const instSellSet = new Set(rawBuckets['inst:sell'].items.filter((i) => i.netAmt < 0).map((i) => i.ticker));
  const indivSellSet = new Set(rawBuckets['indiv:sell'].items.filter((i) => i.netAmt < 0).map((i) => i.ticker));

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

      const isDoubleBuy =
        foreignBuySet.has(item.ticker) &&
        instBuySet.has(item.ticker) &&
        !foreignSellSet.has(item.ticker) &&
        !instSellSet.has(item.ticker);
      const isDoubleSell =
        foreignSellSet.has(item.ticker) &&
        instSellSet.has(item.ticker) &&
        !foreignBuySet.has(item.ticker) &&
        !instBuySet.has(item.ticker);
      const isTripleBuy = isDoubleBuy && indivBuySet.has(item.ticker) && !indivSellSet.has(item.ticker);
      const isTripleSell = isDoubleSell && indivSellSet.has(item.ticker) && !indivBuySet.has(item.ticker);

      return {
        ...item,
        netAmt: resolvedAmt,
        price: resolvedPrice,
        changeRate: live?.changeRate ?? item.changeRate,
        isLive: Boolean(live),
        isDoubleBuy,
        isDoubleSell,
        isTripleBuy,
        isTripleSell,
        isEtfOrSpac: isNonCommonStock(item.name),
      };
    });

    mappedItems.sort((a, b) => (isBuy ? b.netAmt - a.netAmt : a.netAmt - b.netAmt));
    parsed.items = mappedItems.map((item, idx) => ({
      ...item,
      rank: idx + 1,
    }));

    rankings[k] = parsed;
  }

  return {
    session: getMarketSession(),
    rankings,
  };
});

app.get('/api/consecutive', async (req) => {
  const days = Math.min(Math.max(Number(req.query.days || 3), 1), 20);
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
      SELECT DISTINCT trade_date
      FROM daily_investor_flows
      ORDER BY trade_date DESC
      LIMIT $1
    ),
    target_days AS (
      SELECT COUNT(*)::int AS avail_days FROM recent_dates
    ),
    ranked AS (
      SELECT
        f.ticker,
        s.name,
        f.trade_date,
        f.close_price,
        f.change_rate,
        f.foreign_net_amt,
        f.inst_net_amt,
        f.indiv_net_amt,
        ROW_NUMBER() OVER (PARTITION BY f.ticker ORDER BY f.trade_date DESC) AS rn
      FROM daily_investor_flows f
      JOIN stocks s ON s.ticker = f.ticker
      WHERE f.trade_date IN (SELECT trade_date FROM recent_dates)
        AND ${condition}
    )
    SELECT
      r.ticker,
      MAX(r.name) AS name,
      COUNT(*)::int AS streak_days,
      (SELECT avail_days FROM target_days) AS available_db_days,
      MAX(CASE WHEN r.rn = 1 THEN r.close_price END) AS close_price,
      MAX(CASE WHEN r.rn = 1 THEN r.change_rate END) AS change_rate,
      SUM(r.foreign_net_amt)::bigint AS total_foreign_amt,
      SUM(r.inst_net_amt)::bigint AS total_inst_amt,
      ${sumExpr}::bigint AS sort_amt
    FROM ranked r
    GROUP BY r.ticker
    HAVING COUNT(*) >= LEAST($1, (SELECT avail_days FROM target_days))
       AND (SELECT avail_days FROM target_days) > 0
    ORDER BY sort_amt DESC
    LIMIT 100
  `;

  const { rows } = await pool.query(sql, [days]);
  return {
    requestedDays: days,
    availableDbDays: rows[0]?.available_db_days ?? 0,
    investor,
    items: rows.map((r) => ({
      ...r,
      isEtfOrSpac: isNonCommonStock(r.name),
    })),
  };
});

app.get('/api/stocks/:ticker/history', async (req) => {
  const { ticker } = req.params;
  const { rows } = await pool.query(
    `SELECT trade_date, close_price, change_rate, foreign_net_amt, inst_net_amt, indiv_net_amt, is_finalized
     FROM daily_investor_flows
     WHERE ticker = $1
     ORDER BY trade_date ASC
     LIMIT 60`,
    [ticker]
  );
  return { ticker, history: rows };
});

app.post('/api/admin/sync-close', async () => {
  await safePollAllRankings();
  await syncDailyCloseToDb(true);
  return { ok: true };
});

const sseClients = new Set();

await subRedis.subscribe('channel:rank_update', 'channel:tick_update');
subRedis.on('message', (channel, message) => {
  const eventName = channel === 'channel:rank_update' ? 'rank_update' : 'tick_update';
  const frame = `event: ${eventName}\ndata: ${message}\n\n`;
  for (const res of sseClients) {
    res.write(frame);
  }
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

  req.raw.on('close', () => {
    sseClients.delete(reply.raw);
  });
});

setInterval(async () => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return;
  const hhmm = now.getHours() * 100 + now.getMinutes();
  if (hhmm >= 800 && hhmm <= 2010) {
    await safePollAllRankings();
  }
}, 20_000);

setInterval(async () => {
  const session = getMarketSession();
  if (session !== 'CLOSED') {
    await syncWsSubscriptions();
  }
}, 30_000);

cron.schedule('*/5 8-20 * * 1-5', async () => {
  await syncDailyCloseToDb(false);
}, { timezone: 'Asia/Seoul' });

cron.schedule('42 15 * * 1-5', async () => {
  await safePollAllRankings();
  await syncDailyCloseToDb(false);
}, { timezone: 'Asia/Seoul' });

cron.schedule('6 20 * * 1-5', async () => {
  await safePollAllRankings();
  await syncDailyCloseToDb(true);
}, { timezone: 'Asia/Seoul' });

cron.schedule('30 20 * * 1-5', async () => {
  await safePollAllRankings();
  await syncDailyCloseToDb(true);
}, { timezone: 'Asia/Seoul' });

const PORT = Number(process.env.PORT || 4000);
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Server] API & SSE 서버 가동 완료 → http://localhost:${PORT}`);

await safePollAllRankings();
await syncDailyCloseToDb(false);
await startKisWebSocket();
