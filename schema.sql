CREATE TABLE IF NOT EXISTS stocks (
  ticker VARCHAR(12) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  market VARCHAR(16) NOT NULL,
  asset_type VARCHAR(16) DEFAULT 'STOCK',
  is_nxt_eligible BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_investor_flows (
  trade_date DATE NOT NULL,
  ticker VARCHAR(12) NOT NULL,
  close_price BIGINT,
  change_rate NUMERIC(6, 2),
  foreign_net_amt BIGINT DEFAULT 0,
  inst_net_amt BIGINT DEFAULT 0,
  indiv_net_amt BIGINT DEFAULT 0,
  pension_net_amt BIGINT DEFAULT 0,
  fin_invest_net_amt BIGINT DEFAULT 0,
  is_finalized BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (trade_date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_flows_date_foreign ON daily_investor_flows (trade_date, foreign_net_amt DESC);
CREATE INDEX IF NOT EXISTS idx_flows_date_inst ON daily_investor_flows (trade_date, inst_net_amt DESC);
