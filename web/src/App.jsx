import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  RefreshCw, Radio, Search, TrendingUp, TrendingDown, X, Flame, Layers,
  Edit3, Check, LayoutGrid, Activity, ArrowUpRight, ArrowLeft, BarChart3, Pin, Gauge,
} from 'lucide-react';

const API_BASE = 'http://localhost:4000';

const SESSION_LABELS = {
  PRE_MARKET: { text: '프리마켓 (08:00~08:50)', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  PRE_OPEN_AUCTION: { text: '장시작 동시호가', color: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  REGULAR: { text: '정규장 실시간', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  POST_CLOSE_AUCTION: { text: '장마감 동시호가', color: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  AFTER_MARKET: { text: '애프터마켓 (15:40~20:00)', color: 'bg-sky-500/20 text-sky-300 border-sky-500/40' },
  CLOSED: { text: '장마감 (최종 집계)', color: 'bg-zinc-700/40 text-zinc-300 border-zinc-600' },
};

const SECTOR_STYLES = {
  반도체: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  '2차전지': 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  '전력·에너지': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  '바이오·헬스케어': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  '조선·해양': 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  '방산·우주': 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  '자동차·모빌리티': 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  '로봇·자동화': 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'AI·SW·플랫폼': 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  '금융·지주': 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
  '화학·소재': 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  '철강·비철': 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  '건설·기계': 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  '엔터·미디어': 'bg-pink-500/15 text-pink-300 border-pink-500/30',
  '소비재·유통': 'bg-lime-500/15 text-lime-300 border-lime-500/30',
  'ETF·스팩': 'bg-zinc-700/30 text-zinc-400 border-zinc-700',
  기타: 'bg-zinc-800/70 text-zinc-400 border-zinc-700/70',
};

const SIGNAL_STYLES = {
  rose: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  amber: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  purple: 'border-purple-500/40 bg-purple-500/15 text-purple-300',
  emerald: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
};

function getSectorBadgeClass(sectorMain) {
  return SECTOR_STYLES[sectorMain] || SECTOR_STYLES['기타'];
}

function formatAmount(val) {
  const num = Number(val || 0);
  if (num === 0) return '0억';
  const abs = Math.abs(num);
  const sign = num > 0 ? '+' : '-';
  if (abs >= 1_000_000) {
    const jo = Math.floor(abs / 1_000_000);
    const eok = Math.round((abs % 1_000_000) / 100);
    return eok > 0 ? `${sign}${jo}조 ${eok.toLocaleString('ko-KR')}억` : `${sign}${jo}조`;
  }
  if (abs >= 100) return `${sign}${Math.round(abs / 100).toLocaleString('ko-KR')}억`;
  return `${sign}${abs.toLocaleString('ko-KR')}백만`;
}

function ThreeInvestorChart({ points, foreignKey, instKey, indivKey, showPriceOverlay = false, height = 210, compact = false }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  if (!points || points.length === 0) {
    return (
      <div className="flex h-36 items-center justify-center rounded-xl border border-zinc-800/70 bg-zinc-900/40 text-xs text-zinc-500">
        20초 단위 실시간 수급 데이터를 수집 중입니다...
      </div>
    );
  }

  const width = compact ? 520 : 760;
  const padL = 62;
  const padR = showPriceOverlay ? 58 : 20;
  const padT = 18;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allVals = [0];
  for (const p of points) {
    allVals.push(Number(p[foreignKey] || 0), Number(p[instKey] || 0), Number(p[indivKey] || 0));
  }
  let minVal = Math.min(...allVals);
  let maxVal = Math.max(...allVals);
  if (minVal === maxVal) { minVal -= 100; maxVal += 100; }
  const range = maxVal - minVal;

  const prices = points.map((p) => Number(p.price || 0)).filter((v) => v > 0);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const priceRange = maxPrice - minPrice || 1;

  const getX = (idx) => (points.length <= 1 ? padL + plotW / 2 : padL + (idx / (points.length - 1)) * plotW);
  const getY = (val) => padT + ((maxVal - Number(val || 0)) / range) * plotH;
  const getPriceY = (pr) => padT + ((maxPrice - Number(pr || minPrice)) / priceRange) * plotH;
  const buildPolyline = (key) => points.map((p, idx) => `${getX(idx).toFixed(1)},${getY(p[key]).toFixed(1)}`).join(' ');
  const pricePolyline = showPriceOverlay && prices.length > 0
    ? points.map((p, idx) => (p.price > 0 ? `${getX(idx).toFixed(1)},${getPriceY(p.price).toFixed(1)}` : null)).filter(Boolean).join(' ')
    : '';

  const zeroY = getY(0);
  const activeIdx = hoverIdx !== null && points[hoverIdx] ? hoverIdx : points.length - 1;
  const activePt = points[activeIdx];

  const handleMouseMove = (e) => {
    if (points.length <= 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = Math.min(Math.max((relX - padL) / plotW, 0), 1);
    setHoverIdx(Math.round(ratio * (points.length - 1)));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/70 px-3 py-1.5 text-xs">
        <span className="font-mono text-zinc-400">
          <strong className="text-zinc-200">{activePt.time}</strong>
          {activePt.price ? ` · ${Number(activePt.price).toLocaleString('ko-KR')}원` : ''}
        </span>
        <div className="flex flex-wrap items-center gap-2.5 font-semibold">
          <span className="text-rose-400">외인 {formatAmount(activePt[foreignKey])}</span>
          <span className="text-amber-300">기관 {formatAmount(activePt[instKey])}</span>
          <span className="text-sky-400">개인 {formatAmount(activePt[indivKey])}</span>
        </div>
      </div>
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full cursor-crosshair select-none" onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>
          <line x1={padL} y1={padT} x2={width - padR} y2={padT} stroke="#27272a" strokeDasharray="3 3" />
          <line x1={padL} y1={zeroY} x2={width - padR} y2={zeroY} stroke="#52525b" strokeWidth="1" />
          <line x1={padL} y1={padT + plotH} x2={width - padR} y2={padT + plotH} stroke="#27272a" strokeDasharray="3 3" />
          <text x={padL - 6} y={padT + 4} textAnchor="end" className="fill-zinc-500 text-[10px]">{formatAmount(maxVal)}</text>
          <text x={padL - 6} y={zeroY + 3} textAnchor="end" className="fill-zinc-400 text-[10px]">0억</text>
          <text x={padL - 6} y={padT + plotH} textAnchor="end" className="fill-zinc-500 text-[10px]">{formatAmount(minVal)}</text>
          {showPriceOverlay && prices.length > 0 && (
            <>
              <text x={width - padR + 6} y={padT + 4} textAnchor="start" className="fill-zinc-400 text-[9px]">{maxPrice.toLocaleString('ko-KR')}</text>
              <text x={width - padR + 6} y={padT + plotH} textAnchor="start" className="fill-zinc-400 text-[9px]">{minPrice.toLocaleString('ko-KR')}</text>
            </>
          )}
          {points.length > 1 && (
            <>
              {pricePolyline && <polyline fill="none" stroke="#e4e4e7" strokeWidth="1.4" strokeDasharray="4 3" opacity="0.65" points={pricePolyline} />}
              <polyline fill="none" stroke="#38bdf8" strokeWidth="2.1" points={buildPolyline(indivKey)} />
              <polyline fill="none" stroke="#fbbf24" strokeWidth="2.1" points={buildPolyline(instKey)} />
              <polyline fill="none" stroke="#fb7185" strokeWidth="2.5" points={buildPolyline(foreignKey)} />
            </>
          )}
          <line x1={getX(activeIdx)} y1={padT} x2={getX(activeIdx)} y2={padT + plotH} stroke="#71717a" strokeDasharray="2 2" />
          <circle cx={getX(activeIdx)} cy={getY(activePt[indivKey])} r="3.8" fill="#38bdf8" />
          <circle cx={getX(activeIdx)} cy={getY(activePt[instKey])} r="3.8" fill="#fbbf24" />
          <circle cx={getX(activeIdx)} cy={getY(activePt[foreignKey])} r="4.3" fill="#fb7185" />
          <text x={padL} y={height - 6} textAnchor="start" className="fill-zinc-500 text-[10px]">{points[0].time}</text>
          <text x={width - padR} y={height - 6} textAnchor="end" className="fill-zinc-400 text-[10px]">{points[points.length - 1].time}</text>
        </svg>
      </div>
    </div>
  );
}

function StockInsightContent({ ticker, initialStock, onNavigate, onSectorUpdated, pinnedTickers = [], onTogglePin, isStandalonePage = false }) {
  const [intradayDetail, setIntradayDetail] = useState(null);
  const [liveTick, setLiveTick] = useState(null);
  const [tickPulse, setTickPulse] = useState(false);
  const [showPriceOverlay, setShowPriceOverlay] = useState(true);
  const [dailyHistory, setDailyHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingSector, setEditingSector] = useState(false);
  const [editForm, setEditForm] = useState({
    sectorMain: initialStock?.sectorMain || '기타',
    sectorSub: initialStock?.sectorSub || '',
    bizSummary: initialStock?.bizSummary || '',
  });

  const loadAll = useCallback(async () => {
    if (!ticker) return;
    try {
      const [intraRes, histRes] = await Promise.all([
        fetch(`${API_BASE}/api/intraday-flow/${ticker}`),
        fetch(`${API_BASE}/api/stocks/${ticker}/history`),
      ]);
      const intraJson = await intraRes.json();
      const histJson = await histRes.json();
      setIntradayDetail(intraJson);
      if (intraJson.liveTick) setLiveTick(intraJson.liveTick);
      setDailyHistory(histJson.history || []);
      setEditForm((prev) => ({
        sectorMain: intraJson.sectorMain || initialStock?.sectorMain || prev.sectorMain || '기타',
        sectorSub: intraJson.sectorSub || initialStock?.sectorSub || prev.sectorSub || '',
        bizSummary: intraJson.bizSummary || initialStock?.bizSummary || prev.bizSummary || '',
      }));
    } catch (err) {
      console.error('종목 상세 조회 실패:', err);
    } finally {
      setLoading(false);
    }
  }, [ticker, initialStock]);

  useEffect(() => { setLoading(true); loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!ticker) return;
    const es = new EventSource(`${API_BASE}/api/stream`);
    es.addEventListener('tick_update', (e) => {
      try {
        const tick = JSON.parse(e.data);
        if (tick.ticker !== ticker) return;
        setLiveTick(tick);
        setTickPulse(true);
        setTimeout(() => setTickPulse(false), 350);
        setIntradayDetail((prev) => {
          if (!prev || !prev.points?.length) return prev;
          const nextPoints = [...prev.points];
          nextPoints[nextPoints.length - 1] = { ...nextPoints[nextPoints.length - 1], price: tick.price, changeRate: tick.changeRate };
          return { ...prev, points: nextPoints };
        });
      } catch {}
    });
    es.addEventListener('rank_update', () => loadAll());
    return () => es.close();
  }, [ticker, loadAll]);

  const saveStockSector = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/stocks/${ticker}/sector`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (data.ok) { setEditingSector(false); await loadAll(); onSectorUpdated?.(); }
    } catch (err) {
      console.error('라벨 수정 실패:', err);
    }
  };

  const periodSums = useMemo(() => {
    const calc = (n) => dailyHistory.slice(-n).reduce(
      (acc, r) => ({
        days: acc.days + 1,
        foreign: acc.foreign + Number(r.foreign_net_amt || 0),
        inst: acc.inst + Number(r.inst_net_amt || 0),
        indiv: acc.indiv + Number(r.indiv_net_amt || 0),
      }),
      { days: 0, foreign: 0, inst: 0, indiv: 0 }
    );
    return [
      { label: '최근 5일', ...calc(5) },
      { label: '최근 20일(1개월)', ...calc(20) },
      { label: '최근 60일(3개월)', ...calc(60) },
      { label: '최근 250일(1년)', ...calc(250) },
    ];
  }, [dailyHistory]);

  const cumulativeDailyPoints = useMemo(() => {
    let cumF = 0;
    let cumI = 0;
    let cumP = 0;
    return dailyHistory.map((r) => {
      cumF += Number(r.foreign_net_amt || 0);
      cumI += Number(r.inst_net_amt || 0);
      cumP += Number(r.indiv_net_amt || 0);
      return {
        time: String(r.trade_date).slice(5, 10),
        price: Number(r.close_price || 0),
        cumForeign: cumF,
        cumInst: cumI,
        cumIndiv: cumP,
      };
    });
  }, [dailyHistory]);

  const stockName = intradayDetail?.name || initialStock?.name || ticker;
  const sectorMain = intradayDetail?.sectorMain || initialStock?.sectorMain || '기타';
  const sectorSub = intradayDetail?.sectorSub || initialStock?.sectorSub || '';
  const bizSummary = intradayDetail?.bizSummary || initialStock?.bizSummary || '';
  const points = intradayDetail?.points || [];
  const signals = intradayDetail?.signals || [];
  const latestPt = points[points.length - 1];
  const currentPrice = liveTick?.price || latestPt?.price || initialStock?.price || 0;
  const currentRate = liveTick?.changeRate ?? latestPt?.changeRate ?? initialStock?.changeRate ?? 0;
  const currentStrength = liveTick?.strength || 0;
  const currentVwap = liveTick?.vwap || 0;
  const isPinned = pinnedTickers.includes(ticker);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold text-white">{stockName}</h2>
            <span className="font-mono text-xs text-zinc-400">{ticker}</span>
            <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${getSectorBadgeClass(sectorMain)}`}>
              {sectorMain}{sectorSub && sectorSub !== '신규·미분류' ? ` · ${sectorSub}` : ''}
            </span>
            <span className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
              <span className={`h-1.5 w-1.5 rounded-full bg-emerald-400 ${tickPulse ? 'scale-150' : ''} transition`} /> LIVE 추적중
            </span>
          </div>
          {bizSummary && <p className="mt-1.5 text-xs text-zinc-300">{bizSummary}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onTogglePin && (
            <button onClick={() => onTogglePin(ticker)} className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${isPinned ? 'border-amber-500/50 bg-amber-500/20 text-amber-300' : 'border-zinc-700 bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700'}`}>
              <Pin className="h-3.5 w-3.5" /> {isPinned ? '멀티차트 고정됨' : '멀티차트 추가'}
            </button>
          )}
          <button onClick={() => setEditingSector((v) => !v)} className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/80 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700">
            <Edit3 className="h-3.5 w-3.5" /> 라벨 수정
          </button>
          {!isStandalonePage && (
            <a href={`/stocks/${ticker}`} onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); onNavigate(`/stocks/${ticker}`); } }} className="flex items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/25">
              전용 페이지 <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className={`rounded-xl border p-3 transition ${tickPulse ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-800 bg-[#141418]'}`}>
          <div className="text-[11px] text-zinc-400">실시간 체결가</div>
          <div className="mt-1 text-base font-bold text-white">{Number(currentPrice).toLocaleString('ko-KR')}원</div>
          <div className={`text-xs font-semibold ${currentRate > 0 ? 'text-rose-400' : currentRate < 0 ? 'text-blue-400' : 'text-zinc-400'}`}>{currentRate > 0 ? `+${currentRate}%` : `${currentRate}%`}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-[#141418] p-3">
          <div className="flex items-center gap-1 text-[11px] text-zinc-400"><Gauge className="h-3.5 w-3.5 text-emerald-400" /> 실시간 체결강도</div>
          <div className={`mt-1 text-base font-bold ${currentStrength >= 100 ? 'text-rose-400' : currentStrength > 0 ? 'text-blue-400' : 'text-zinc-400'}`}>{currentStrength > 0 ? `${currentStrength.toFixed(1)}%` : '-'}</div>
          <div className="text-[11px] text-zinc-500">{currentStrength >= 100 ? '매수 체결 우위' : currentStrength > 0 ? '매도 체결 우위' : '체결 대기중'}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-[#141418] p-3">
          <div className="text-[11px] text-zinc-400">당일 평균단가 (VWAP)</div>
          <div className="mt-1 text-base font-bold text-zinc-100">{currentVwap > 0 ? `${currentVwap.toLocaleString('ko-KR')}원` : '-'}</div>
          <div className="text-[11px] text-zinc-500">{currentVwap > 0 && currentPrice > 0 ? (currentPrice >= currentVwap ? '평균단가 상회' : '평균단가 하회') : '장중 집계중'}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-[#141418] p-3">
          <div className="text-[11px] text-zinc-400">외인+기관 당일 합계</div>
          <div className={`mt-1 text-base font-bold ${(latestPt?.foreignNet || 0) + (latestPt?.instNet || 0) >= 0 ? 'text-rose-400' : 'text-blue-400'}`}>
            {formatAmount((latestPt?.foreignNet || 0) + (latestPt?.instNet || 0))}
          </div>
          <div className="text-[11px] text-zinc-400">외 {formatAmount(latestPt?.foreignNet || 0)} · 기 {formatAmount(latestPt?.instNet || 0)}</div>
        </div>
      </div>

      {signals.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {signals.map((sig) => (
            <span key={sig.type} className={`rounded-full border px-3 py-1 text-xs font-semibold ${SIGNAL_STYLES[sig.tone] || SIGNAL_STYLES.rose}`}>{sig.label}</span>
          ))}
        </div>
      )}

      {editingSector && (
        <div className="space-y-2.5 rounded-xl border border-zinc-700/80 bg-zinc-900/90 p-3.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">대분류 섹터</label>
              <select value={editForm.sectorMain} onChange={(e) => setEditForm((f) => ({ ...f, sectorMain: e.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-white">
                {Object.keys(SECTOR_STYLES).map((sec) => <option key={sec} value={sec}>{sec}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">세부 밸류체인 (12자 이내)</label>
              <input type="text" value={editForm.sectorSub} onChange={(e) => setEditForm((f) => ({ ...f, sectorSub: e.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-white" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-zinc-400">한 줄 사업 요약</label>
            <input type="text" value={editForm.bizSummary} onChange={(e) => setEditForm((f) => ({ ...f, bizSummary: e.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-white" />
          </div>
          <div className="flex justify-end">
            <button onClick={saveStockSector} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">
              <Check className="h-3.5 w-3.5" /> DB에 즉시 저장
            </button>
          </div>
        </div>
      )}

      <section className="rounded-xl border border-zinc-800/80 bg-[#141418] p-4">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">당일 3주체(외국인·기관·개인) 실시간 수급 추이</h3>
            <span className="text-[11px] text-zinc-500">{points.length}구간</span>
          </div>
          <button onClick={() => setShowPriceOverlay((v) => !v)} className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold transition ${showPriceOverlay ? 'border-zinc-500 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-zinc-900 text-zinc-500'}`}>
            주가 추이 점선 {showPriceOverlay ? 'ON' : 'OFF'}
          </button>
        </div>
        <ThreeInvestorChart points={points} foreignKey="foreignNet" instKey="instNet" indivKey="indivNet" showPriceOverlay={showPriceOverlay} height={isStandalonePage ? 250 : 195} />
      </section>

      <section className="rounded-xl border border-zinc-800/80 bg-[#141418] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-white">일별 투자자 누적 수급 히스토리 (PostgreSQL)</h3>
          <span className="text-[11px] text-zinc-400">총 {dailyHistory.length}거래일 누적</span>
        </div>
        {dailyHistory.length > 0 && (
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {periodSums.map((p) => (
              <div key={p.label} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5 text-xs">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-zinc-400">
                  <span className="font-semibold text-zinc-200">{p.label}</span><span>({p.days}일)</span>
                </div>
                <div className="space-y-0.5 text-[11px]">
                  <div className="flex justify-between"><span className="text-zinc-400">외국인</span><span className={p.foreign >= 0 ? 'font-bold text-rose-400' : 'font-bold text-blue-400'}>{formatAmount(p.foreign)}</span></div>
                  <div className="flex justify-between"><span className="text-zinc-400">기관</span><span className={p.inst >= 0 ? 'font-bold text-amber-300' : 'font-bold text-blue-400'}>{formatAmount(p.inst)}</span></div>
                  <div className="flex justify-between"><span className="text-zinc-400">개인</span><span className={p.indiv >= 0 ? 'font-bold text-sky-400' : 'font-bold text-blue-400'}>{formatAmount(p.indiv)}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}
        {cumulativeDailyPoints.length > 1 && (
          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-semibold text-zinc-400">1년치 일별 누적 수급 추이 (외국인·기관·개인)</div>
            <ThreeInvestorChart points={cumulativeDailyPoints} foreignKey="cumForeign" instKey="cumInst" indivKey="cumIndiv" showPriceOverlay={true} height={180} />
          </div>
        )}
        {loading && dailyHistory.length === 0 ? (
          <p className="py-6 text-center text-xs text-zinc-500">1년치 일별 수급 기록을 불러오는 중입니다...</p>
        ) : dailyHistory.length === 0 ? (
          <p className="py-6 text-center text-xs text-zinc-500">저장된 일별 수급 기록이 아직 없습니다.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800/70">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-900 text-[11px] text-zinc-400">
                <tr>
                  <th className="px-3 py-2">일자</th><th className="px-2 py-2 text-right">종가</th><th className="px-2 py-2 text-right">등락</th>
                  <th className="px-2 py-2 text-right text-rose-400">외국인</th><th className="px-2 py-2 text-right text-amber-300">기관</th><th className="px-3 py-2 text-right text-sky-400">개인</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {[...dailyHistory].reverse().map((row) => {
                  const rt = Number(row.change_rate || 0);
                  return (
                    <tr key={row.trade_date}>
                      <td className="px-3 py-1.5 font-mono text-zinc-300">{String(row.trade_date).slice(0, 10)}</td>
                      <td className="px-2 py-1.5 text-right text-zinc-200">{Number(row.close_price).toLocaleString('ko-KR')}</td>
                      <td className={`px-2 py-1.5 text-right ${rt > 0 ? 'text-rose-400' : rt < 0 ? 'text-blue-400' : 'text-zinc-400'}`}>{rt > 0 ? `+${rt}%` : `${rt}%`}</td>
                      <td className={`px-2 py-1.5 text-right font-semibold ${Number(row.foreign_net_amt) >= 0 ? 'text-rose-400' : 'text-blue-400'}`}>{formatAmount(row.foreign_net_amt)}</td>
                      <td className={`px-2 py-1.5 text-right font-semibold ${Number(row.inst_net_amt) >= 0 ? 'text-amber-300' : 'text-blue-400'}`}>{formatAmount(row.inst_net_amt)}</td>
                      <td className={`px-3 py-1.5 text-right font-semibold ${Number(row.indiv_net_amt) >= 0 ? 'text-sky-400' : 'text-blue-400'}`}>{formatAmount(row.indiv_net_amt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function FlowPageView({ intradayData, multiCharts, pinnedTickers, onTogglePin, onSelectStock, selectedSector, onSelectSector, excludeEtf, query }) {
  const [intradaySort, setIntradaySort] = useState('smart');

  const sortedIntradayStocks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (intradayData.stocks || []).filter((it) => {
      if (excludeEtf && it.isEtfOrSpac) return false;
      if (selectedSector !== 'ALL' && it.sectorMain !== selectedSector) return false;
      if (q && !`${it.name} ${it.ticker} ${it.sectorMain || ''} ${it.sectorSub || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return [...list].sort((a, b) => {
      if (intradaySort === 'delta') return Math.abs(b.smartMoneyDelta) - Math.abs(a.smartMoneyDelta);
      if (intradaySort === 'foreign') return b.foreignNet - a.foreignNet;
      if (intradaySort === 'inst') return b.instNet - a.instNet;
      if (intradaySort === 'indiv') return b.indivNet - a.indivNet;
      return Math.abs(b.smartMoneyAmt) - Math.abs(a.smartMoneyAmt);
    });
  }, [intradayData.stocks, excludeEtf, selectedSector, query, intradaySort]);

  const latestMarketPoint = intradayData.timeline?.[intradayData.timeline.length - 1] || { time: '-', totalForeign: 0, totalInst: 0, totalIndiv: 0 };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-zinc-800/90 bg-[#17171c] p-5 shadow-lg">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white">실시간 관심종목 멀티 수급 레이더 ({multiCharts.length} / 4종목)</h2>
              <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">0.1초 체결 + 20초 수급 실시간</span>
            </div>
            <p className="mt-0.5 text-xs text-zinc-400">하단 스캐너의 핀(📌) 버튼으로 최대 4종목까지 고정해 실시간 수급 추이를 동시 비교합니다</p>
          </div>
        </div>
        {multiCharts.length === 0 ? (
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 py-10 text-center text-xs text-zinc-500">
            하단 스캐너에서 종목 옆 핀(📌) 버튼을 눌러 실시간 추적할 종목을 추가해 주세요.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {multiCharts.map((mc) => {
              const pr = mc.liveTick?.price || mc.points?.[mc.points.length - 1]?.price || 0;
              const rt = mc.liveTick?.changeRate ?? mc.points?.[mc.points.length - 1]?.changeRate ?? 0;
              const stg = mc.liveTick?.strength || 0;
              return (
                <div key={mc.ticker} className="rounded-xl border border-zinc-800/90 bg-[#131317] p-4 shadow-md">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button onClick={() => onSelectStock(mc)} className="text-sm font-bold text-white hover:text-emerald-300">{mc.name}</button>
                        <span className="font-mono text-[11px] text-zinc-500">{mc.ticker}</span>
                        <span className={`rounded border px-1.5 py-0.2 text-[10px] ${getSectorBadgeClass(mc.sectorMain)}`}>{mc.sectorMain} · {mc.sectorSub}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-zinc-200">{Number(pr).toLocaleString('ko-KR')}원</span>
                        <span className={rt > 0 ? 'text-rose-400' : rt < 0 ? 'text-blue-400' : 'text-zinc-400'}>{rt > 0 ? `+${rt}%` : `${rt}%`}</span>
                        {stg > 0 && <span className={`rounded px-1.5 py-0.2 text-[10px] font-semibold ${stg >= 100 ? 'bg-rose-500/15 text-rose-300' : 'bg-blue-500/15 text-blue-300'}`}>체결강도 {stg.toFixed(1)}%</span>}
                      </div>
                    </div>
                    <button onClick={() => onTogglePin(mc.ticker)} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="제거"><X className="h-4 w-4" /></button>
                  </div>
                  {mc.signals?.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {mc.signals.map((sig) => (
                        <span key={sig.type} className={`rounded-full border px-2 py-0.2 text-[10px] font-semibold ${SIGNAL_STYLES[sig.tone] || SIGNAL_STYLES.rose}`}>{sig.label}</span>
                      ))}
                    </div>
                  )}
                  <ThreeInvestorChart points={mc.points} foreignKey="foreignNet" instKey="instNet" indivKey="indivNet" showPriceOverlay={true} height={165} compact={true} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800/90 bg-[#17171c] p-5 shadow-lg">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-white">장중 3주체(외국인·기관·개인) 시장 전체 누적 수급 추이</h2>
            <p className="mt-0.5 text-xs text-zinc-400">상위 100종목군 합산 기준 · 마우스 호버로 시점별 누적 금액 확인</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs font-semibold">
            <span className="flex items-center gap-1.5 text-rose-400"><span className="h-2.5 w-2.5 rounded-full bg-rose-400" />외국인 {formatAmount(latestMarketPoint.totalForeign)}</span>
            <span className="flex items-center gap-1.5 text-amber-300"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" />기관 {formatAmount(latestMarketPoint.totalInst)}</span>
            <span className="flex items-center gap-1.5 text-sky-400"><span className="h-2.5 w-2.5 rounded-full bg-sky-400" />개인 {formatAmount(latestMarketPoint.totalIndiv)}</span>
          </div>
        </div>
        <ThreeInvestorChart points={intradayData.timeline} foreignKey="totalForeign" instKey="totalInst" indivKey="totalIndiv" height={200} />
      </section>

      {intradayData.sectorSummary?.length > 0 && (
        <section className="rounded-2xl border border-zinc-800/90 bg-[#17171c] p-5 shadow-lg">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-indigo-400" /><h3 className="text-sm font-bold text-white">섹터별 3주체 자금 이동 현황판 (개별주 기준)</h3></div>
            <span className="text-[11px] text-zinc-500">섹터 카드 클릭 시 하단 스캐너 필터링</span>
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {intradayData.sectorSummary.slice(0, 12).map((sec) => (
              <button key={sec.sector} onClick={() => onSelectSector((prev) => (prev === sec.sector ? 'ALL' : sec.sector))} className={`rounded-xl border p-3 text-left transition ${selectedSector === sec.sector ? 'border-white/50 bg-zinc-800' : 'border-zinc-800/80 bg-zinc-900/60 hover:bg-zinc-800/60'}`}>
                <div className="flex items-center justify-between">
                  <span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${getSectorBadgeClass(sec.sector)}`}>{sec.sector}</span>
                  <span className="text-[11px] text-zinc-400">{sec.count}종목</span>
                </div>
                <div className="mt-2.5 space-y-1 text-[11px]">
                  <div className="flex justify-between"><span className="text-zinc-400">외국인</span><span className={sec.foreignNet >= 0 ? 'font-bold text-rose-400' : 'font-bold text-blue-400'}>{formatAmount(sec.foreignNet)}</span></div>
                  <div className="flex justify-between"><span className="text-zinc-400">기관</span><span className={sec.instNet >= 0 ? 'font-bold text-amber-300' : 'font-bold text-blue-400'}>{formatAmount(sec.instNet)}</span></div>
                  <div className="flex justify-between"><span className="text-zinc-400">개인</span><span className={sec.indivNet >= 0 ? 'font-bold text-sky-400' : 'font-bold text-blue-400'}>{formatAmount(sec.indivNet)}</span></div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-zinc-800/90 bg-[#17171c] shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 px-4 py-3">
          <div>
            <h3 className="text-sm font-bold text-white">종목별 3주체 실시간 누적 및 직전 대비 증감(Δ) 스캐너</h3>
            <p className="text-[11px] text-zinc-400">행 클릭 시 실시간 추이 패널 오픈 · 핀(📌) 클릭 시 상단 멀티 차트 고정</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[{ id: 'smart', label: '외인+기관 규모순' }, { id: 'delta', label: '직전대비 급변(Δ)순' }, { id: 'foreign', label: '외국인순' }, { id: 'inst', label: '기관순' }, { id: 'indiv', label: '개인순' }].map((s) => (
              <button key={s.id} onClick={() => setIntradaySort(s.id)} className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${intradaySort === s.id ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>{s.label}</button>
            ))}
          </div>
        </div>
        <div className="max-h-[68vh] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/95 text-[11px] text-zinc-400">
              <tr>
                <th className="w-10 px-3 py-2.5 text-center">고정</th><th className="px-3 py-2.5">종목 / 상세 섹터</th><th className="px-3 py-2.5 text-right">현재가 · 등락</th>
                <th className="px-3 py-2.5 text-right text-rose-400">외국인 (직전대비)</th><th className="px-3 py-2.5 text-right text-amber-300">기관 (직전대비)</th><th className="px-4 py-2.5 text-right text-sky-400">개인 (직전대비)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {sortedIntradayStocks.slice(0, 120).map((st) => {
                const isPinned = pinnedTickers.includes(st.ticker);
                const renderCell = (amt, delta, posColor) => (
                  <div>
                    <div className={`font-bold ${amt > 0 ? posColor : amt < 0 ? 'text-blue-400' : 'text-zinc-500'}`}>{formatAmount(amt)}</div>
                    {delta !== 0 && <div className={`text-[10px] font-semibold ${delta > 0 ? 'text-rose-400' : 'text-blue-400'}`}>{delta > 0 ? `▲${formatAmount(delta)}` : `▼${formatAmount(delta)}`}</div>}
                  </div>
                );
                return (
                  <tr key={st.ticker} onClick={() => onSelectStock(st)} className="cursor-pointer transition hover:bg-zinc-800/45">
                    <td className="px-3 py-2.5 text-center" onClick={(e) => { e.stopPropagation(); onTogglePin(st.ticker); }}>
                      <button className={`rounded p-1 transition ${isPinned ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300'}`}><Pin className="h-3.5 w-3.5" /></button>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-zinc-100">{st.name}</span><span className="font-mono text-[11px] text-zinc-500">{st.ticker}</span>
                        <span className={`rounded border px-1.5 py-0.2 text-[10px] ${getSectorBadgeClass(st.sectorMain)}`}>{st.sectorMain} · {st.sectorSub}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="font-medium text-zinc-200">{Number(st.price || 0).toLocaleString('ko-KR')}원</div>
                      <div className={`text-[11px] ${st.changeRate > 0 ? 'text-rose-400' : st.changeRate < 0 ? 'text-blue-400' : 'text-zinc-400'}`}>{st.changeRate > 0 ? `+${st.changeRate}%` : `${st.changeRate}%`}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right">{renderCell(st.foreignNet, st.deltaForeign, 'text-rose-400')}</td>
                    <td className="px-3 py-2.5 text-right">{renderCell(st.instNet, st.deltaInst, 'text-amber-300')}</td>
                    <td className="px-4 py-2.5 text-right">{renderCell(st.indivNet, st.deltaIndiv, 'text-sky-400')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname || '/');
  const [rankings, setRankings] = useState({});
  const [session, setSession] = useState('CLOSED');
  const [rankingTab, setRankingTab] = useState('buy');
  const [query, setQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState('ALL');
  const [groupBySector, setGroupBySector] = useState(false);
  const [onlyDouble, setOnlyDouble] = useState(false);
  const [onlyTriple, setOnlyTriple] = useState(false);
  const [excludeEtf, setExcludeEtf] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState('-');
  const [pinnedTickers, setPinnedTickers] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('krx_pinned_tickers') || '[]');
      if (Array.isArray(saved) && saved.length > 0) return saved.slice(0, 4);
    } catch {}
    return ['005930', '000660', '009150', '036930'];
  });
  const [multiCharts, setMultiCharts] = useState([]);
  const [intradayData, setIntradayData] = useState({ updatedAt: '-', timeline: [], sectorSummary: [], stocks: [] });
  const [consecDays, setConsecDays] = useState(3);
  const [consecInvestor, setConsecInvestor] = useState('foreign');
  const [consecData, setConsecData] = useState({ availableDbDays: 0, items: [] });
  const [drawerStock, setDrawerStock] = useState(null);

  const togglePinTicker = useCallback((ticker) => {
    setPinnedTickers((prev) => {
      const next = prev.includes(ticker) ? prev.filter((t) => t !== ticker) : [ticker, ...prev].slice(0, 4);
      localStorage.setItem('krx_pinned_tickers', JSON.stringify(next));
      return next;
    });
  }, []);

  const navigate = useCallback((to) => {
    if (window.location.pathname === to) return;
    window.history.pushState({}, '', to);
    setPathname(to);
    setDrawerStock(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const onPopState = () => { setPathname(window.location.pathname || '/'); setDrawerStock(null); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const isFlowPage = pathname === '/flow';
  const stockPageMatch = pathname.match(/^\/stocks\/([A-Za-z0-9]{6})$/);
  const standaloneTicker = stockPageMatch ? stockPageMatch[1] : null;

  const fetchRankings = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/rankings`);
      const data = await res.json();
      setSession(data.session || 'CLOSED');
      setRankings(data.rankings || {});
      setLastSyncTime(new Date().toLocaleTimeString('ko-KR', { hour12: false }));
    } catch (err) {
      console.error('랭킹 조회 실패:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMultiCharts = useCallback(async () => {
    if (!pinnedTickers.length) { setMultiCharts([]); return; }
    try {
      const res = await fetch(`${API_BASE}/api/intraday-flow/batch?tickers=${pinnedTickers.join(',')}`);
      const data = await res.json();
      setMultiCharts(data.items || []);
    } catch {}
  }, [pinnedTickers]);

  const fetchIntradayFlow = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/intraday-flow`);
      const data = await res.json();
      setSession(data.session || 'CLOSED');
      setIntradayData(data);
      setLastSyncTime(new Date().toLocaleTimeString('ko-KR', { hour12: false }));
    } catch {} finally { setLoading(false); }
  }, []);

  const fetchConsecutive = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/consecutive?days=${consecDays}&investor=${consecInvestor}`);
      const data = await res.json();
      setConsecData(data);
    } catch {} finally { setLoading(false); }
  }, [consecDays, consecInvestor]);

  useEffect(() => {
    if (isFlowPage) { fetchIntradayFlow(); fetchMultiCharts(); }
    else if (!standaloneTicker) {
      fetchRankings();
      if (rankingTab === 'consecutive') fetchConsecutive();
    }
  }, [isFlowPage, standaloneTicker, rankingTab, fetchRankings, fetchIntradayFlow, fetchMultiCharts, fetchConsecutive]);

  useEffect(() => {
    if (!autoRefresh) { setSseConnected(false); return; }
    const es = new EventSource(`${API_BASE}/api/stream`);
    es.addEventListener('connected', (e) => {
      setSseConnected(true);
      try { const parsed = JSON.parse(e.data); if (parsed.session) setSession(parsed.session); } catch {}
    });
    es.addEventListener('rank_update', () => {
      if (isFlowPage) { fetchIntradayFlow(); fetchMultiCharts(); }
      else if (!standaloneTicker) fetchRankings();
    });
    es.addEventListener('tick_update', (e) => {
      try {
        const tick = JSON.parse(e.data);
        setRankings((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            if (!next[key]?.items) continue;
            next[key] = { ...next[key], items: next[key].items.map((item) => item.ticker === tick.ticker ? { ...item, price: tick.price, changeRate: tick.changeRate, strength: tick.strength || item.strength, isLive: true } : item) };
          }
          return next;
        });
        if (isFlowPage) setMultiCharts((prev) => prev.map((mc) => (mc.ticker === tick.ticker ? { ...mc, liveTick: tick } : mc)));
      } catch {}
    });
    es.onerror = () => setSseConnected(false);
    const backupTimer = setInterval(() => {
      if (isFlowPage) { fetchIntradayFlow(); fetchMultiCharts(); }
      else if (!standaloneTicker) fetchRankings();
    }, 15_000);
    return () => { es.close(); clearInterval(backupTimer); };
  }, [autoRefresh, isFlowPage, standaloneTicker, fetchRankings, fetchIntradayFlow, fetchMultiCharts]);

  const side = rankingTab === 'sell' ? 'sell' : 'buy';

  const availableSectors = useMemo(() => {
    const counts = new Map();
    const seen = new Set();
    const list = isFlowPage ? (intradayData.stocks || []) : [`foreign:${side}`, `inst:${side}`, `indiv:${side}`].flatMap((k) => rankings[k]?.items || []);
    for (const it of list) {
      if (excludeEtf && it.isEtfOrSpac) continue;
      if (seen.has(it.ticker)) continue;
      seen.add(it.ticker);
      const sec = it.sectorMain || '기타';
      counts.set(sec, (counts.get(sec) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [isFlowPage, intradayData.stocks, rankings, side, excludeEtf]);

  const sessionMeta = SESSION_LABELS[session] || SESSION_LABELS.CLOSED;
  const columns = [{ id: 'foreign', title: '외국인', badge: 'FOREIGN' }, { id: 'inst', title: '기관 합계', badge: 'INSTITUTION' }, { id: 'indiv', title: '개인', badge: 'INDIVIDUAL' }];

  const renderStockRow = (item) => {
    const isUp = item.changeRate > 0;
    const isDown = item.changeRate < 0;
    const showDouble = side === 'buy' ? item.isDoubleBuy : item.isDoubleSell;
    const showTriple = side === 'buy' ? item.isTripleBuy : item.isTripleSell;
    return (
      <button key={item.ticker} onClick={() => setDrawerStock(item)} className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-zinc-800/45">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex w-7 shrink-0 flex-col items-center pt-0.5">
            <span className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${item.rank <= 3 ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}>{item.rank}</span>
            {item.isNew ? <span className="mt-0.5 text-[9px] font-bold text-emerald-400">NEW</span> : item.rankDiff > 0 ? <span className="mt-0.5 text-[9px] font-semibold text-rose-400">▲{item.rankDiff}</span> : item.rankDiff < 0 ? <span className="mt-0.5 text-[9px] font-semibold text-blue-400">▼{Math.abs(item.rankDiff)}</span> : null}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-zinc-100">{item.name}</span>
              {item.isLive && <span className="rounded bg-emerald-500/15 px-1 py-0.2 text-[10px] font-semibold text-emerald-400">LIVE</span>}
              {showTriple ? <span className="rounded bg-purple-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-purple-300">{side === 'buy' ? '3주체 매수' : '3주체 매도'}</span> : showDouble && <span className="rounded bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-amber-300">{side === 'buy' ? '쌍끌이 매수' : '쌍끌이 매도'}</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className={`inline-flex items-center rounded border px-1.5 py-0.2 text-[10px] font-medium ${getSectorBadgeClass(item.sectorMain)}`}>{item.sectorMain || '기타'}{item.sectorSub && item.sectorSub !== '신규·미분류' ? ` · ${item.sectorSub}` : ''}</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400">
              <span>{item.ticker}</span><span>·</span><span className="font-medium text-zinc-300">{Number(item.price || 0).toLocaleString('ko-KR')}원</span>
              <span className={isUp ? 'text-rose-400' : isDown ? 'text-blue-400' : 'text-zinc-400'}>{isUp ? `+${item.changeRate}%` : `${item.changeRate}%`}</span>
            </div>
          </div>
        </div>
        <div className="ml-2 shrink-0 text-right">
          <div className={`text-sm font-bold ${side === 'buy' ? 'text-rose-400' : 'text-blue-400'}`}>{formatAmount(item.netAmt)}</div>
          <div className="text-[11px] text-zinc-500">{item.netQty ? `${Number(item.netQty).toLocaleString('ko-KR')}주` : '금액기준'}</div>
        </div>
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-[#101013] text-gray-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-[#101013]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <a href="/" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); navigate('/'); } }} className="text-lg font-bold tracking-tight text-white hover:text-zinc-200">KRX·NXT 수급 레이더</a>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${sessionMeta.color}`}>{sessionMeta.text}</span>
            <span className="flex items-center gap-1.5 text-xs text-zinc-400"><Radio className={`h-3.5 w-3.5 ${sseConnected ? 'text-emerald-400 animate-pulse' : 'text-zinc-600'}`} />{sseConnected ? '실시간 스트림' : '연결 대기'}</span>
            <button onClick={() => setAutoRefresh((v) => !v)} className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold transition ${autoRefresh ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>자동 {autoRefresh ? 'ON' : 'OFF'}</button>
            <span className="hidden sm:inline text-[11px] text-zinc-500">동기화 {lastSyncTime}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <nav className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-1">
              <a href="/" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); navigate('/'); setRankingTab('buy'); } }} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition ${pathname === '/' && rankingTab === 'buy' ? 'bg-rose-500/20 text-rose-400' : 'text-zinc-400 hover:text-zinc-200'}`}><TrendingUp className="h-3.5 w-3.5" /> 순매수 상위</a>
              <a href="/" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); navigate('/'); setRankingTab('sell'); } }} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition ${pathname === '/' && rankingTab === 'sell' ? 'bg-blue-500/20 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}><TrendingDown className="h-3.5 w-3.5" /> 순매도 상위</a>
              <a href="/flow" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); navigate('/flow'); } }} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition ${isFlowPage ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-400 hover:text-zinc-200'}`}><Activity className="h-3.5 w-3.5" /> 3주체 수급 추이 <ArrowUpRight className="h-3 w-3 opacity-70" /></a>
              <a href="/" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); navigate('/'); setRankingTab('consecutive'); } }} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition ${pathname === '/' && rankingTab === 'consecutive' ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-400 hover:text-zinc-200'}`}><Flame className="h-3.5 w-3.5" /> 연속 순매수</a>
            </nav>
            {!standaloneTicker && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-500" />
                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="종목·섹터·HBM·변압기" className="w-40 sm:w-48 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-8 pr-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none" />
              </div>
            )}
            <button onClick={() => { if (isFlowPage) { fetchIntradayFlow(); fetchMultiCharts(); } else if (rankingTab === 'consecutive') fetchConsecutive(); else fetchRankings(); }} disabled={loading} className="rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
          </div>
        </div>
        {!standaloneTicker && (isFlowPage || rankingTab !== 'consecutive') && (
          <div className="border-t border-zinc-800/60 bg-[#131317]">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2">
              {!isFlowPage && (
                <>
                  <button onClick={() => setGroupBySector((v) => !v)} className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold transition ${groupBySector ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}><LayoutGrid className="h-3.5 w-3.5" /> 섹터별 묶어보기</button>
                  <button onClick={() => { setOnlyDouble((v) => !v); setOnlyTriple(false); }} className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${onlyDouble ? 'border-amber-500/50 bg-amber-500/20 text-amber-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>{side === 'buy' ? '쌍끌이 매수만' : '쌍끌이 매도만'}</button>
                  <button onClick={() => { setOnlyTriple((v) => !v); setOnlyDouble(false); }} className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${onlyTriple ? 'border-purple-500/50 bg-purple-500/20 text-purple-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>{side === 'buy' ? '3주체 매수만' : '3주체 매도만'}</button>
                </>
              )}
              <button onClick={() => setExcludeEtf((v) => !v)} className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${excludeEtf ? 'border-sky-500/50 bg-sky-500/20 text-sky-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>ETF·스팩 제외 {excludeEtf ? 'ON' : 'OFF'}</button>
              <span className="mx-1 h-4 w-px bg-zinc-800" />
              <div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
                <Layers className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <button onClick={() => setSelectedSector('ALL')} className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${selectedSector === 'ALL' ? 'border-white/30 bg-white/15 text-white' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>전체 섹터</button>
                {availableSectors.map(([sec, cnt]) => (
                  <button key={sec} onClick={() => setSelectedSector((prev) => (prev === sec ? 'ALL' : sec))} className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${selectedSector === sec ? 'border-white/50 bg-white/20 text-white' : `${getSectorBadgeClass(sec)} opacity-85 hover:opacity-100`}`}>{sec} <span className="opacity-70">{cnt}</span></button>
                ))}
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5">
        {standaloneTicker ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <button onClick={() => navigate('/')} className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"><ArrowLeft className="h-3.5 w-3.5" /> 수급 레이더로 돌아가기</button>
              <span className="font-mono text-xs text-zinc-500">URL: /stocks/{standaloneTicker}</span>
            </div>
            <div className="rounded-2xl border border-zinc-800/90 bg-[#17171c] p-6 shadow-xl">
              <StockInsightContent ticker={standaloneTicker} onNavigate={navigate} pinnedTickers={pinnedTickers} onTogglePin={togglePinTicker} isStandalonePage={true} />
            </div>
          </div>
        ) : isFlowPage ? (
          <FlowPageView intradayData={intradayData} multiCharts={multiCharts} pinnedTickers={pinnedTickers} onTogglePin={togglePinTicker} onSelectStock={setDrawerStock} selectedSector={selectedSector} onSelectSector={setSelectedSector} excludeEtf={excludeEtf} query={query} />
        ) : rankingTab === 'consecutive' ? (
          <section className="rounded-2xl border border-zinc-800/90 bg-[#17171c] p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white">PostgreSQL 누적 연속 순매수 추적</h2>
                <p className="text-xs text-zinc-400">현재 DB 누적 영업일: <strong className="text-emerald-300">{consecData.availableDbDays}일</strong> · 종목 클릭 시 1년치 일별 수급 히스토리 확인</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[{ id: 'foreign', label: '외국인 연속' }, { id: 'inst', label: '기관 연속' }, { id: 'both', label: '외인+기관 동시연속' }].map((tab) => (
                  <button key={tab.id} onClick={() => setConsecInvestor(tab.id)} className={`rounded-lg border px-3 py-1 text-xs font-semibold ${consecInvestor === tab.id ? 'border-amber-500/50 bg-amber-500/20 text-amber-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400'}`}>{tab.label}</button>
                ))}
                {[2, 3, 5, 10, 20].map((d) => (
                  <button key={d} onClick={() => setConsecDays(d)} className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${consecDays === d ? 'border-rose-500/50 bg-rose-500/20 text-rose-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400'}`}>{d}일</button>
                ))}
              </div>
            </div>
            <div className="divide-y divide-zinc-800/60">
              {(consecData.items || []).filter((it) => (!excludeEtf || !it.isEtfOrSpac)).map((item, idx) => (
                <button key={item.ticker} onClick={() => setDrawerStock(item)} className="flex w-full items-center justify-between rounded-lg px-2 py-3 text-left hover:bg-zinc-800/40">
                  <div className="flex items-center gap-3">
                    <span className="w-6 text-center text-xs font-bold text-zinc-400">{idx + 1}</span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-white">{item.name}</span>
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">{item.streak_days}일 연속</span>
                        <span className={`rounded border px-1.5 py-0.2 text-[10px] font-medium ${getSectorBadgeClass(item.sectorMain)}`}>{item.sectorMain} · {item.sectorSub}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-400">{item.ticker} · 종가 {Number(item.close_price || 0).toLocaleString('ko-KR')}원</div>
                    </div>
                  </div>
                  <div className="text-right text-xs">
                    <div className="font-bold text-rose-400">외인 {formatAmount(item.total_foreign_amt)}</div>
                    <div className="font-semibold text-amber-300">기관 {formatAmount(item.total_inst_amt)}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {columns.map((col) => {
              const bucket = rankings[`${col.id}:${side}`] || { updatedAt: '-', items: [] };
              const q = query.trim().toLowerCase();
              const filtered = bucket.items.filter((it) => {
                if (excludeEtf && it.isEtfOrSpac) return false;
                if (onlyDouble && !(side === 'buy' ? it.isDoubleBuy : it.isDoubleSell)) return false;
                if (onlyTriple && !(side === 'buy' ? it.isTripleBuy : it.isTripleSell)) return false;
                if (selectedSector !== 'ALL' && it.sectorMain !== selectedSector) return false;
                if (q && !`${it.name} ${it.ticker} ${it.sectorMain || ''} ${it.sectorSub || ''}`.toLowerCase().includes(q)) return false;
                return true;
              });
              const groupedBySector = (() => {
                const map = new Map();
                for (const it of filtered) {
                  const sec = it.sectorMain || '기타';
                  if (!map.has(sec)) map.set(sec, { sector: sec, totalAmt: 0, items: [] });
                  const grp = map.get(sec);
                  grp.totalAmt += Number(it.netAmt || 0);
                  grp.items.push(it);
                }
                return [...map.values()].sort((a, b) => Math.abs(b.totalAmt) - Math.abs(a.totalAmt));
              })();
              return (
                <section key={col.id} className="flex flex-col overflow-hidden rounded-2xl border border-zinc-800/90 bg-[#17171c] shadow-lg">
                  <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-3">
                    <div><span className="text-[10px] font-semibold tracking-wider text-zinc-500">{col.badge}</span><h2 className="text-base font-bold text-white">{col.title} {side === 'buy' ? '순매수' : '순매도'}</h2></div>
                    <div className="text-right"><span className="block text-xs font-semibold text-zinc-300">{filtered.length}종목</span><span className="block text-[11px] text-zinc-500">기준 {bucket.updatedAt || '-'}</span></div>
                  </div>
                  <div className="max-h-[76vh] divide-y divide-zinc-800/50 overflow-y-auto">
                    {filtered.length === 0 ? (
                      <div className="py-14 text-center text-xs text-zinc-500">조건에 맞는 종목이 없습니다.</div>
                    ) : groupBySector ? (
                      groupedBySector.map((grp) => (
                        <div key={grp.sector} className="divide-y divide-zinc-800/40">
                          <div className="sticky top-0 z-10 flex items-center justify-between bg-zinc-900/95 px-4 py-2 backdrop-blur-xs">
                            <div className="flex items-center gap-2"><span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${getSectorBadgeClass(grp.sector)}`}>{grp.sector}</span><span className="text-[11px] text-zinc-400">{grp.items.length}종목</span></div>
                            <span className={`text-xs font-bold ${side === 'buy' ? 'text-rose-400' : 'text-blue-400'}`}>합계 {formatAmount(grp.totalAmt)}</span>
                          </div>
                          {grp.items.map((item) => renderStockRow(item))}
                        </div>
                      ))
                    ) : (
                      filtered.map((item) => renderStockRow(item))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>

      {drawerStock && !standaloneTicker && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs" onClick={() => setDrawerStock(null)}>
          <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-zinc-800 bg-[#18181d] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-400">종목 실시간 3주체 변화 & 1년치 일별 수급</span>
              <button onClick={() => setDrawerStock(null)} className="rounded-lg border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300 hover:bg-zinc-700 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <StockInsightContent ticker={drawerStock.ticker} initialStock={drawerStock} onNavigate={navigate} pinnedTickers={pinnedTickers} onTogglePin={togglePinTicker} onSectorUpdated={() => { if (isFlowPage) { fetchIntradayFlow(); fetchMultiCharts(); } else fetchRankings(); }} isStandalonePage={false} />
          </aside>
        </div>
      )}
    </div>
  );
}
