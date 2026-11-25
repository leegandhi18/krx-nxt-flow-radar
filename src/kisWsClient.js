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
      tr_type: isSubscribe ? '1' : '2', // 1: 등록, 2: 해제
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
  const rankKeys = ['rank:foreign:buy', 'rank:inst:buy', 'rank:indiv:buy'];

  for (const key of rankKeys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const { items } = JSON.parse(raw);
    for (const item of items.slice(0, 14)) {
      if (targetSet.size < MAX_SUBS) targetSet.add(item.ticker);
    }
  }

  // 기본 대표 종목 폴백 (초기 랭킹 비어있을 때 대비)
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

export async function startKisWebSocket() {
  try {
    approvalKey = await getKisApprovalKey();
    ws = new WebSocket(process.env.KIS_WS_URL);

    ws.on('open', async () => {
      console.log('[KIS WS] 실시간 체결가 서버 연결 성공');
      subscribedTickers.clear();
      await syncWsSubscriptions();
    });

    ws.on('message', async (rawBuf) => {
      const msg = rawBuf.toString('utf8');

      // JSON 제어 메시지 (구독 응답 및 PINGPONG 하트비트)
      if (msg.startsWith('{')) {
        try {
          const json = JSON.parse(msg);
          if (json.header?.tr_id === 'PINGPONG') {
            ws.send(msg); // 하트비트 에코 응답 필수
          }
        } catch {}
        return;
      }

      // 실시간 체결 전문 파싱: 암호화여부|TR_ID|건수|데이터(^구분)
      const parts = msg.split('|');
      if (parts.length < 4 || parts[1] !== 'H0UNCNT0') return;

      const fields = parts[3].split('^');
      const tick = {
        ticker: fields[0],
        time: fields[1],
        price: Math.abs(Number(fields[2])),
        change: Number(fields[4]),
        changeRate: Number(fields[5]),
        volume: Number(fields[13]),
        tradeAmt: Number(fields[14]),
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
