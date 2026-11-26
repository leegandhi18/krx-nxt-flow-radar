import WebSocket from 'ws';
import { getKisApprovalKey, redis, pubRedis } from './authManager.js';

let ws = null;
let approvalKey = null;
const subscribedTickers = new Set();
const MAX_SUBS = Number(process.env.MAX_WS_SUBSCRIPTIONS || 40);

function sendSubscription(ticker, isSubscribe = true) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !approvalKey) return;

  const payload = {
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: isSubscribe ? '1' : '2',
      'content-type': 'utf-8',
    },
    body: {
      input: {
        tr_id: 'H0UNCNT0', // KRX + NXT 통합 실시간 체결가
        tr_key: ticker,
      },
    },
  };
  ws.send(JSON.stringify(payload));
}

export async function syncWsSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const targetSet = new Set();

  // 1순위: 사용자가 현재 조회 중이거나 멀티 차트에 고정한 우선순위 종목 (최근 30분 이내)
  const now = Date.now();
  await redis.zremrangebyscore('ws:priority', 0, now - 30 * 60 * 1000);
  const priorityTickers = await redis.zrevrange('ws:priority', 0, 11);
  for (const t of priorityTickers) {
    if (t && t.length === 6 && targetSet.size < MAX_SUBS) {
      targetSet.add(t);
    }
  }

  // 2순위: 외국인·기관·개인 수급 상위 종목으로 나머지 슬롯 채우기
  const rankKeys = ['rank:foreign:buy', 'rank:inst:buy', 'rank:indiv:buy'];
  for (const key of rankKeys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const { items } = JSON.parse(raw);
    for (const item of items.slice(0, 14)) {
      if (targetSet.size < MAX_SUBS) targetSet.add(item.ticker);
    }
  }

  if (targetSet.size === 0) {
    ['005930', '000660', '035420', '068270', '196170'].forEach((t) => targetSet.add(t));
  }

  for (const oldTicker of subscribedTickers) {
    if (!targetSet.has(oldTicker)) {
      sendSubscription(oldTicker, false);
      subscribedTickers.delete(oldTicker);
    }
  }

  for (const newTicker of targetSet) {
    if (!subscribedTickers.has(newTicker)) {
      sendSubscription(newTicker, true);
      subscribedTickers.add(newTicker);
    }
  }
}

export async function registerPriorityTickers(tickers = []) {
  const valid = tickers.filter((t) => typeof t === 'string' && /^[0-9A-Za-z]{6}$/.test(t));
  if (!valid.length) return;
  const now = Date.now();
  for (const t of valid) {
    await redis.zadd('ws:priority', now, t);
  }
  await syncWsSubscriptions();
}

export async function startKisWebSocket() {
  try {
    approvalKey = await getKisApprovalKey();
    ws = new WebSocket(process.env.KIS_WS_URL);

    ws.on('open', async () => {
      console.log('[KIS WS] 실시간 체결가·체결강도 서버 연결 성공');
      subscribedTickers.clear();
      await syncWsSubscriptions();
    });

    ws.on('message', async (rawBuf) => {
      const msg = rawBuf.toString('utf8');

      if (msg.startsWith('{')) {
        try {
          const json = JSON.parse(msg);
          if (json.header?.tr_id === 'PINGPONG') {
            ws.send(msg);
          }
        } catch {}
        return;
      }

      const parts = msg.split('|');
      if (parts.length < 4 || parts[1] !== 'H0UNCNT0') return;

      const fields = parts[3].split('^');
      const vwapRaw = Number(fields[6]);
      const strengthRaw = Number(fields[18]);

      const tick = {
        ticker: fields[0],
        time: fields[1],
        price: Math.abs(Number(fields[2])),
        change: Number(fields[4]),
        changeRate: Number(fields[5]),
        vwap: Number.isFinite(vwapRaw) && vwapRaw > 0 ? Math.abs(Math.round(vwapRaw)) : 0,
        volume: Number(fields[13]) || 0,
        tradeAmt: Number(fields[14]) || 0,
        strength: Number.isFinite(strengthRaw) && strengthRaw > 0 ? strengthRaw : 0,
        ts: Date.now(),
      };

      await redis.hset('live:ticks', tick.ticker, JSON.stringify(tick));
      await pubRedis.publish('channel:tick_update', JSON.stringify(tick));
    });

    ws.on('close', () => {
      console.warn('[KIS WS] 연결 종료됨 — 5초 후 재연결 시도');
      setTimeout(startKisWebSocket, 5000);
    });

    ws.on('error', (err) => {
      console.error('[KIS WS] 소켓 에러:', err.message);
    });
  } catch (err) {
    console.error('[KIS WS] 초기화 실패:', err.message);
    setTimeout(startKisWebSocket, 10000);
  }
}
