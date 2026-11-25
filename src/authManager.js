import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL);
export const pubRedis = new Redis(process.env.REDIS_URL);
export const subRedis = new Redis(process.env.REDIS_URL);

const TOKEN_TTL_SEC = 60 * 60 * 23; // 23시간 캐싱

export async function getKiwoomToken() {
  const cached = await redis.get('auth:kiwoom:token');
  if (cached) return cached;

  const isMock = process.env.KIWOOM_ENV === 'mock';
  const baseUrl = isMock ? process.env.KIWOOM_MOCK_BASE_URL : process.env.KIWOOM_BASE_URL;
  const appkey = isMock ? process.env.KIWOOM_MOCK_APP_KEY : process.env.KIWOOM_APP_KEY;
  const secretkey = isMock ? process.env.KIWOOM_MOCK_SECRET_KEY : process.env.KIWOOM_SECRET_KEY;

  const res = await fetch(`${baseUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, secretkey }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`키움 토큰 발급 실패: ${JSON.stringify(data)}`);

  await redis.set('auth:kiwoom:token', data.token, 'EX', TOKEN_TTL_SEC);
  return data.token;
}

export async function getKisToken() {
  const cached = await redis.get('auth:kis:token');
  if (cached) return cached;

  const res = await fetch(`${process.env.KIS_BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`한투 REST 토큰 발급 실패: ${JSON.stringify(data)}`);

  await redis.set('auth:kis:token', data.access_token, 'EX', TOKEN_TTL_SEC);
  return data.access_token;
}

export async function getKisApprovalKey() {
  const cached = await redis.get('auth:kis:approval');
  if (cached) return cached;

  const res = await fetch(`${process.env.KIS_BASE_URL}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      secretkey: process.env.KIS_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.approval_key) throw new Error(`한투 WS 접속키 발급 실패: ${JSON.stringify(data)}`);

  await redis.set('auth:kis:approval', data.approval_key, 'EX', TOKEN_TTL_SEC);
  return data.approval_key;
}
