import { useEffect, useState, useCallback, useRef } from 'react';
import {
  RefreshCw,
  Radio,
  Search,
  TrendingUp,
  TrendingDown,
  Flame,
  Users,
  CalendarRange,
  Filter,
  Pause,
  Play,
  X,
} from 'lucide-react';

const API_BASE = 'http://localhost:4000';
const AUTO_POLL_MS = 15000;

const SESSION_LABELS = {
  PRE_MARKET: { text: '프리마켓 (08:00~08:50)', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  PRE_OPEN_AUCTION: { text: '장시작 동시호가', color: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  REGULAR: { text: '정규장 실시간', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  POST_CLOSE_AUCTION: { text: '장마감 동시호가', color: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  AFTER_MARKET: { text: '애프터마켓 (15:40~20:00)', color: 'bg-sky-500/20 text-sky-300 border-sky-500/40' },
  CLOSED: { text: '장마감 (최종 집계)', color: 'bg-zinc-700/40 text-zinc-300 border-zinc-600' },
};

function formatAmount(val) {
  const num = Number(val || 0);
  if (num === 0) return '0만';
  const abs = Math.abs(num);
  const sign = num > 0 ? '+' : '-';

  if (abs >= 1_000_000) {
    let jo = Math.floor(abs / 1_000_000);
    let remEok = Math.round((abs % 1_000_000) / 100);
    if (remEok === 10000) {
      jo += 1;
      remEok = 0;
    }
    return remEok > 0
      ? `${sign}${jo.toLocaleString('ko-KR')}조 ${remEok.toLocaleString('ko-KR')}억`
      : `${sign}${jo.toLocaleString('ko-KR')}조`;
  }

  if (abs >= 100) {
    const eok = abs / 100;
    if (eok >= 1000) {
      return `${sign}${Math.round(eok).toLocaleString('ko-KR')}억`;
    }
    const formatted = Number(eok.toFixed(1)).toLocaleString('ko-KR');
    return `${sign}${formatted}억`;
  }

  const man = Math.round(abs * 100);
  return `${sign}${man.toLocaleString('ko-KR')}만`;
}

export default function App() {
  const [rankings, setRankings] = useState({});
  const [session, setSession] = useState('CLOSED');
  const [viewMode, setViewMode] = useState('buy'); // 'buy' | 'sell' | 'streak'
  const [onlyDouble, setOnlyDouble] = useState(false); // 쌍끌이 매수/매도 필터
  const [onlyTriple, setOnlyTriple] = useState(false); // 3주체 매수/매도 필터
  const [excludeEtf, setExcludeEtf] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [query, setQuery] = useState('');
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState('-');
  const [flashMap, setFlashMap] = useState({});

  const [streakDays, setStreakDays] = useState(3);
  const [streakInvestor, setStreakInvestor] = useState('foreign');
  const [streakData, setStreakData] = useState({ availableDbDays: 0, items: [] });

  const [selectedStock, setSelectedStock] = useState(null);
  const [history, setHistory] = useState([]);

  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const stampSyncTime = () => {
    setLastSyncedAt(
      new Date().toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    );
  };

  const triggerFlash = (ticker, dir) => {
    setFlashMap((prev) => ({ ...prev, [ticker]: dir }));
    setTimeout(() => {
      setFlashMap((prev) => {
        const next = { ...prev };
        delete next[ticker];
        return next;
      });
    }, 800);
  };

  const fetchRankings = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const res = await fetch(`${API_BASE}/api/rankings`);
      const data = await res.json();
      setSession(data.session || 'CLOSED');
      setRankings(data.rankings || {});
      stampSyncTime();
    } catch (err) {
      console.error('랭킹 조회 실패:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const fetchConsecutive = useCallback(
    async (silent = false) => {
      try {
        if (!silent) setLoading(true);
        const res = await fetch(
          `${API_BASE}/api/consecutive?days=${streakDays}&investor=${streakInvestor}`
        );
        const data = await res.json();
        setStreakData(data);
        stampSyncTime();
      } catch (err) {
        console.error('연속 순매수 조회 실패:', err);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [streakDays, streakInvestor]
  );

  useEffect(() => {
    fetchRankings(false);
    if (!autoRefresh) {
      setSseConnected(false);
      return;
    }

    const es = new EventSource(`${API_BASE}/api/stream`);

    es.onopen = () => {
      setSseConnected(true);
      fetchRankings(true);
      if (viewModeRef.current === 'streak') fetchConsecutive(true);
    };

    es.addEventListener('connected', (e) => {
      setSseConnected(true);
      try {
        const parsed = JSON.parse(e.data);
        if (parsed.session) setSession(parsed.session);
      } catch {}
    });

    es.addEventListener('rank_update', () => {
      fetchRankings(true);
      if (viewModeRef.current === 'streak') {
        fetchConsecutive(true);
      }
    });

    es.addEventListener('tick_update', (e) => {
      try {
        const tick = JSON.parse(e.data);
        let flashDir = null;

        setRankings((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            if (!next[key]?.items) continue;
            next[key] = {
              ...next[key],
              items: next[key].items.map((item) => {
                if (item.ticker !== tick.ticker) return item;
                if (item.price && tick.price !== item.price) {
                  flashDir = tick.price > item.price ? 'up' : 'down';
                }
                return { ...item, price: tick.price, changeRate: tick.changeRate, isLive: true };
              }),
            };
          }
          return next;
        });

        if (flashDir) triggerFlash(tick.ticker, flashDir);
        stampSyncTime();
      } catch {}
    });

    es.onerror = () => {
      setSseConnected(false);
    };

    return () => es.close();
  }, [autoRefresh, fetchRankings, fetchConsecutive]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      fetchRankings(true);
      if (viewModeRef.current === 'streak') {
        fetchConsecutive(true);
      }
    }, AUTO_POLL_MS);

    return () => clearInterval(timer);
  }, [autoRefresh, fetchRankings, fetchConsecutive]);

  useEffect(() => {
    if (viewMode === 'streak') {
      fetchConsecutive(false);
    }
  }, [viewMode, fetchConsecutive]);

  const openStockHistory = async (item) => {
    setSelectedStock(item);
    setHistory([]);
    try {
      const res = await fetch(`${API_BASE}/api/stocks/${item.ticker}/history`);
      const data = await res.json();
      setHistory(data.history || []);
    } catch (err) {
      console.error('히스토리 조회 실패:', err);
    }
  };

  const toggleDoubleFilter = () => {
    setOnlyDouble((prev) => {
      const next = !prev;
      if (next) setOnlyTriple(false);
      return next;
    });
  };

  const toggleTripleFilter = () => {
    setOnlyTriple((prev) => {
      const next = !prev;
      if (next) setOnlyDouble(false);
      return next;
    });
  };

  const columns = [
    { id: 'foreign', title: '외국인', badge: 'FOREIGN' },
    { id: 'inst', title: '기관 합계', badge: 'INSTITUTION' },
    { id: 'indiv', title: '개인', badge: 'INDIVIDUAL' },
  ];

  const sessionMeta = SESSION_LABELS[session] || SESSION_LABELS.CLOSED;

  return (
    <div className="min-h-screen bg-[#101013] text-gray-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-[#101013]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg font-bold tracking-tight text-white">KRX·NXT 수급 레이더</h1>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${sessionMeta.color}`}>
                {sessionMeta.text}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Radio
                  className={`h-3.5 w-3.5 ${
                    autoRefresh && sseConnected ? 'text-emerald-400 animate-pulse' : 'text-zinc-600'
                  }`}
                />
                {autoRefresh ? (sseConnected ? '실시간 자동반영' : '자동폴링 대기') : '일시정지'}
              </span>
              <span className="hidden sm:inline text-[11px] text-zinc-500">
                화면 동기화 {lastSyncedAt}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-500" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="종목명·코드 검색"
                  className="w-36 sm:w-48 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-8 pr-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none"
                />
              </div>

              <button
                onClick={() => setAutoRefresh((v) => !v)}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                  autoRefresh
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
                title="실시간 자동 갱신 켜기/끄기"
              >
                {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {autoRefresh ? '자동 ON' : '자동 OFF'}
              </button>

              <button
                onClick={() => (viewMode === 'streak' ? fetchConsecutive(false) : fetchRankings(false))}
                disabled={loading}
                className="rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                title="즉시 수동 새로고침"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-800/60">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setViewMode('buy')}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  viewMode === 'buy'
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                }`}
              >
                <TrendingUp className="h-3.5 w-3.5" /> 순매수 상위
              </button>

              <button
                onClick={() => setViewMode('sell')}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  viewMode === 'sell'
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                }`}
              >
                <TrendingDown className="h-3.5 w-3.5" /> 순매도 상위
              </button>

              <button
                onClick={() => setViewMode('streak')}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  viewMode === 'streak'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                }`}
              >
                <CalendarRange className="h-3.5 w-3.5" /> 연속 순매수 추적
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {viewMode !== 'streak' && (
                <>
                  <button
                    onClick={toggleDoubleFilter}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                      onlyDouble
                        ? viewMode === 'buy'
                          ? 'border-fuchsia-500/50 bg-fuchsia-500/20 text-fuchsia-300'
                          : 'border-sky-500/50 bg-sky-500/20 text-sky-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Flame className="h-3.5 w-3.5" />
                    {viewMode === 'buy' ? '쌍끌이 매수만' : '쌍끌이 매도만'}
                  </button>

                  <button
                    onClick={toggleTripleFilter}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                      onlyTriple
                        ? viewMode === 'buy'
                          ? 'border-amber-500/50 bg-amber-500/20 text-amber-300'
                          : 'border-indigo-500/50 bg-indigo-500/25 text-indigo-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Users className="h-3.5 w-3.5" />
                    {viewMode === 'buy' ? '3주체 매수만' : '3주체 매도만'}
                  </button>
                </>
              )}

              <button
                onClick={() => setExcludeEtf((v) => !v)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                  excludeEtf
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Filter className="h-3.5 w-3.5" />
                개별주만 (ETF·스팩 제외)
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {viewMode === 'streak' ? (
          <section className="rounded-2xl border border-zinc-800 bg-[#17171c] p-5 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
              <div>
                <h2 className="text-base font-bold text-white">PostgreSQL 연속 순매수 추적</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  현재 DB 누적 거래일수: <span className="text-amber-300 font-semibold">{streakData.availableDbDays}일</span>
                  {streakData.availableDbDays < streakDays && (
                    <span className="ml-1.5 text-zinc-500">
                      (장 마감 정산이 매일 쌓이면 {streakDays}일 연속 필터가 자동 확장됩니다)
                    </span>
                  )}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-1">
                  {[2, 3, 5].map((d) => (
                    <button
                      key={d}
                      onClick={() => setStreakDays(d)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                        streakDays === d ? 'bg-amber-500/25 text-amber-300' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {d}일 연속
                    </button>
                  ))}
                </div>

                <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-1">
                  {[
                    { id: 'foreign', label: '외국인' },
                    { id: 'inst', label: '기관' },
                    { id: 'both', label: '외인+기관 동시' },
                  ].map((inv) => (
                    <button
                      key={inv.id}
                      onClick={() => setStreakInvestor(inv.id)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                        streakInvestor === inv.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {inv.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto max-h-[70vh] overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-800 text-zinc-400">
                  <tr>
                    <th className="py-2.5 px-2">종목명</th>
                    <th className="py-2.5 px-2 text-center">연속일수</th>
                    <th className="py-2.5 px-2 text-right">최근 종가</th>
                    <th className="py-2.5 px-2 text-right">등락률</th>
                    <th className="py-2.5 px-2 text-right">누적 외국인</th>
                    <th className="py-2.5 px-2 text-right">누적 기관</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {streakData.items
                    .filter((it) => !excludeEtf || !it.isEtfOrSpac)
                    .filter(
                      (it) =>
                        !query.trim() ||
                        it.name.toLowerCase().includes(query.trim().toLowerCase()) ||
                        it.ticker.includes(query.trim())
                    )
                    .map((row) => {
                      const rate = Number(row.change_rate || 0);
                      return (
                        <tr
                          key={row.ticker}
                          onClick={() => openStockHistory({ ticker: row.ticker, name: row.name })}
                          className="cursor-pointer hover:bg-zinc-800/40"
                        >
                          <td className="py-3 px-2 font-semibold text-zinc-100">
                            {row.name}{' '}
                            <span className="ml-1 font-normal text-zinc-500">{row.ticker}</span>
                          </td>
                          <td className="py-3 px-2 text-center">
                            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold text-amber-300">
                              {row.streak_days}일 연속
                            </span>
                          </td>
                          <td className="py-3 px-2 text-right text-zinc-200">
                            {Number(row.close_price || 0).toLocaleString('ko-KR')}원
                          </td>
                          <td
                            className={`py-3 px-2 text-right font-medium ${
                              rate > 0 ? 'text-rose-400' : rate < 0 ? 'text-blue-400' : 'text-zinc-400'
                            }`}
                          >
                            {rate > 0 ? `+${rate}%` : `${rate}%`}
                          </td>
                          <td className="py-3 px-2 text-right font-semibold text-rose-400">
                            {formatAmount(row.total_foreign_amt)}
                          </td>
                          <td className="py-3 px-2 text-right font-semibold text-amber-300">
                            {formatAmount(row.total_inst_amt)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {columns.map((col) => {
              const bucket = rankings[`${col.id}:${viewMode}`] || { updatedAt: '-', items: [] };
              const filtered = bucket.items
                .filter((it) => !excludeEtf || !it.isEtfOrSpac)
                .filter((it) => {
                  if (onlyTriple) {
                    return viewMode === 'buy' ? it.isTripleBuy : it.isTripleSell;
                  }
                  if (onlyDouble) {
                    return viewMode === 'buy' ? it.isDoubleBuy : it.isDoubleSell;
                  }
                  return true;
                })
                .filter(
                  (it) =>
                    !query.trim() ||
                    it.name.toLowerCase().includes(query.trim().toLowerCase()) ||
                    it.ticker.includes(query.trim())
                );

              return (
                <section
                  key={col.id}
                  className="flex flex-col rounded-2xl border border-zinc-800/90 bg-[#17171c] shadow-lg overflow-hidden"
                >
                  <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-3.5">
                    <div>
                      <span className="text-[10px] font-semibold tracking-wider text-zinc-500">{col.badge}</span>
                      <h2 className="text-base font-bold text-white">
                        {col.title} {viewMode === 'buy' ? '순매수' : '순매도'}
                      </h2>
                    </div>
                    <div className="text-right">
                      <span className="block text-xs text-zinc-400 font-medium">{filtered.length}종목</span>
                      <span className="block text-[11px] text-zinc-500">기준 {bucket.updatedAt || '-'}</span>
                    </div>
                  </div>

                  <div className="divide-y divide-zinc-800/50 max-h-[76vh] overflow-y-auto">
                    {filtered.length === 0 ? (
                      <div className="py-12 text-center text-xs text-zinc-500">
                        조건에 해당하는 종목이 없습니다.
                      </div>
                    ) : (
                      filtered.map((item) => {
                        const isUp = item.changeRate > 0;
                        const isDown = item.changeRate < 0;
                        const isTriple = viewMode === 'buy' ? item.isTripleBuy : item.isTripleSell;
                        const isDouble = viewMode === 'buy' ? item.isDoubleBuy : item.isDoubleSell;
                        const flash = flashMap[item.ticker];

                        return (
                          <button
                            key={item.ticker}
                            onClick={() => openStockHistory(item)}
                            className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors duration-300 hover:bg-zinc-800/40 ${
                              flash === 'up'
                                ? 'bg-rose-500/15'
                                : flash === 'down'
                                ? 'bg-blue-500/15'
                                : ''
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="flex w-9 shrink-0 flex-col items-center">
                                <span
                                  className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${
                                    item.rank <= 3 ? 'bg-zinc-800 text-white' : 'text-zinc-400'
                                  }`}
                                >
                                  {item.rank}
                                </span>
                                {item.isNew ? (
                                  <span className="mt-0.5 rounded bg-amber-500/20 px-1 text-[9px] font-bold text-amber-300">
                                    NEW
                                  </span>
                                ) : item.rankDiff > 0 ? (
                                  <span className="mt-0.5 text-[10px] font-bold text-rose-400">
                                    ▲{item.rankDiff}
                                  </span>
                                ) : item.rankDiff < 0 ? (
                                  <span className="mt-0.5 text-[10px] font-bold text-blue-400">
                                    ▼{Math.abs(item.rankDiff)}
                                  </span>
                                ) : null}
                              </div>

                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="truncate text-sm font-semibold text-zinc-100">
                                    {item.name}
                                  </span>
                                  {isTriple ? (
                                    <span
                                      className={`rounded px-1.5 py-0.2 text-[10px] font-bold border ${
                                        viewMode === 'buy'
                                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                          : 'bg-indigo-500/25 text-indigo-300 border-indigo-500/40'
                                      }`}
                                    >
                                      {viewMode === 'buy' ? '3주체 매수' : '3주체 매도'}
                                    </span>
                                  ) : isDouble ? (
                                    <span
                                      className={`rounded px-1.5 py-0.2 text-[10px] font-bold border ${
                                        viewMode === 'buy'
                                          ? 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30'
                                          : 'bg-sky-500/20 text-sky-300 border-sky-500/30'
                                      }`}
                                    >
                                      {viewMode === 'buy' ? '쌍끌이 매수' : '쌍끌이 매도'}
                                    </span>
                                  ) : null}
                                  {item.isLive && (
                                    <span className="rounded bg-emerald-500/15 px-1 py-0.2 text-[10px] font-semibold text-emerald-400">
                                      LIVE
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
                                  <span>{item.ticker}</span>
                                  <span>·</span>
                                  <span className="font-medium text-zinc-300">
                                    {item.price.toLocaleString('ko-KR')}원
                                  </span>
                                  <span
                                    className={
                                      isUp ? 'text-rose-400' : isDown ? 'text-blue-400' : 'text-zinc-400'
                                    }
                                  >
                                    {isUp ? `+${item.changeRate}%` : `${item.changeRate}%`}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="text-right shrink-0 ml-2">
                              <div
                                className={`text-sm font-bold ${
                                  viewMode === 'buy' ? 'text-rose-400' : 'text-blue-400'
                                }`}
                              >
                                {formatAmount(item.netAmt)}
                              </div>
                              <div className="text-[11px] text-zinc-500">
                                {item.netQty ? `${item.netQty.toLocaleString('ko-KR')}주` : '금액기준'}
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>

      {selectedStock && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
          onClick={() => setSelectedStock(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#18181d] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-white">
                  {selectedStock.name}{' '}
                  <span className="text-xs font-normal text-zinc-400">{selectedStock.ticker}</span>
                </h3>
                <p className="text-xs text-zinc-400">PostgreSQL 누적 일별 투자자 수급 내역</p>
              </div>
              <button
                onClick={() => setSelectedStock(null)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 max-h-72 overflow-y-auto">
              {history.length === 0 ? (
                <p className="py-8 text-center text-xs text-zinc-500">저장된 일별 수급 기록을 불러오는 중입니다.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 text-zinc-400">
                    <tr>
                      <th className="py-2">일자</th>
                      <th className="py-2 text-right">종가</th>
                      <th className="py-2 text-right">외국인</th>
                      <th className="py-2 text-right">기관</th>
                      <th className="py-2 text-right">개인</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {history.map((row) => (
                      <tr key={row.trade_date}>
                        <td className="py-2 text-zinc-300">{String(row.trade_date).slice(0, 10)}</td>
                        <td className="py-2 text-right text-zinc-200">
                          {Number(row.close_price).toLocaleString('ko-KR')}
                        </td>
                        <td className="py-2 text-right text-rose-400">{formatAmount(row.foreign_net_amt)}</td>
                        <td className="py-2 text-right text-amber-300">{formatAmount(row.inst_net_amt)}</td>
                        <td className="py-2 text-right text-sky-300">{formatAmount(row.indiv_net_amt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
