-- ============================================================
-- KRX · NXT 실시간 수급 레이더 PostgreSQL 16 데이터베이스 스키마
-- ============================================================

-- 1. 종목 마스터 및 AI 섹터·밸류체인 라벨 테이블
CREATE TABLE IF NOT EXISTS stocks (
  ticker VARCHAR(12) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  market VARCHAR(16) NOT NULL DEFAULT 'KRX', -- KOSPI | KOSDAQ | KRX
  asset_type VARCHAR(16) DEFAULT 'STOCK',    -- STOCK | ETF | ETN | SPAC
  is_nxt_eligible BOOLEAN DEFAULT FALSE,
  sector_main VARCHAR(32),                   -- 16대 핵심 섹터 (반도체, 2차전지, 전력·에너지 등)
  sector_sub VARCHAR(64),                    -- 세부 밸류체인 (12자 이내 구체화 라벨)
  biz_summary VARCHAR(200),                  -- 한 줄 사업 요약
  sector_source VARCHAR(16) DEFAULT 'RULE',  -- AI | RULE | MANUAL
  sector_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 기존 테이블에 섹터 컬럼이 없는 경우를 위한 멱등성 보강
ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS sector_main VARCHAR(32),
  ADD COLUMN IF NOT EXISTS sector_sub VARCHAR(64),
  ADD COLUMN IF NOT EXISTS biz_summary VARCHAR(200),
  ADD COLUMN IF NOT EXISTS sector_source VARCHAR(16) DEFAULT 'RULE',
  ADD COLUMN IF NOT EXISTS sector_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_stocks_sector_main ON stocks (sector_main);

-- 2. 일별 투자자별 순매수 확정 데이터 (단위: 백만 원)
CREATE TABLE IF NOT EXISTS daily_investor_flows (
  trade_date DATE NOT NULL,
  ticker VARCHAR(12) NOT NULL,
  close_price BIGINT,
  change_rate NUMERIC(6, 2),
  foreign_net_amt BIGINT DEFAULT 0,          -- 외국인 순매수 금액
  inst_net_amt BIGINT DEFAULT 0,             -- 기관 합계 순매수 금액
  indiv_net_amt BIGINT DEFAULT 0,            -- 개인 순매수 금액
  pension_net_amt BIGINT DEFAULT 0,          -- 연기금 순매수 금액
  fin_invest_net_amt BIGINT DEFAULT 0,       -- 금융투자 순매수 금액
  is_finalized BOOLEAN DEFAULT FALSE,        -- TRUE: 장마감 최종 확정치
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trade_date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_flows_date_foreign ON daily_investor_flows (trade_date, foreign_net_amt DESC);
CREATE INDEX IF NOT EXISTS idx_flows_date_inst ON daily_investor_flows (trade_date, inst_net_amt DESC);
