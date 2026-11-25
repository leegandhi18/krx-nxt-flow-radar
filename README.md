<div align="center">

# 📊 KRX · NXT 실시간 수급 레이더 (Real-time Investor Flow Radar)

**한국거래소(KRX) · 넥스트레이드(NXT) 통합 실시간 투자자별(외국인·기관·개인) 수급 분석 및 시각화 대시보드**

[![Node.js](https://img.shields.io/badge/Node.js-24.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![React](https://img.shields.io/badge/React-19.x-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io/)

</div>

---

## ✨ 프로젝트 개요

**KRX·NXT 실시간 수급 레이더**는 프리마켓(`08:00`)부터 정규장(`09:00~15:30`), 애프터마켓(`15:40~20:00`)까지 전 시간대의 투자자별 수급(외국인·기관·개인)과 실시간 체결가를 추적하는 풀스택 금융 데이터 대시보드입니다.

키움증권 REST API의 **통합 시장(`stex_tp: '3'`) 누적 수급 집계**와 한국투자증권 WebSocket의 **초저지연 통합 체결가 스트림(`H0UNCNT0`)**을 결합하여, 단 1번의 페이지 로드 이후 브라우저 새로고침(`F5`) 없이도 순위 변동과 체결 가격을 실시간으로 반영합니다.

---

## 🏗️ 시스템 아키텍처

```mermaid
flowchart LR
    subgraph External["증권사 Open API"]
        KW["키움 REST API<br/>(ka10058 · ka10065)"]
        KIS_WS["한국투자증권 WS<br/>(H0UNCNT0 통합체결)"]
        KIS_REST["한국투자증권 REST<br/>(FHKST01010100)"]
    end

    subgraph Backend["Node.js · Fastify 서버"]
        AUTH["Auth Manager<br/>(토큰 23h 중앙 캐싱)"]
        POLLER["Kiwoom Poller<br/>(TPS 큐 · 정합성 정제 · 20s)"]
        WS_CLI["KIS WS Client<br/>(실시간 시세 구독)"]
        CRON["Cron Scheduler<br/>(5분 백업 · 15:42/20:06 정산)"]
    end

    subgraph Storage["인메모리 & 영구 저장소"]
        REDIS[("Redis 7<br/>rank:* · live:ticks · Pub/Sub")]
        PG[("PostgreSQL 16<br/>stocks · daily_investor_flows")]
    end

    subgraph Frontend["React 19 · Vite 대시보드"]
        UI["3단 수급 보드 UI<br/>(SSE 스트림 + 15s 폴링 이중화)"]
    end

    KW --> POLLER
    KIS_REST --> POLLER
    KIS_WS --> WS_CLI
    AUTH <--> REDIS

    POLLER -->|SET / HSET / PUBLISH| REDIS
    WS_CLI -->|HSET / PUBLISH| REDIS
    REDIS -->|UPSERT 일별 누적| PG

    REDIS -->|SSE 실시간 푸시| UI
    PG -->|연속 순매수 · 히스토리| UI
```

---

## 🚀 핵심 기능

### 1. 전 시간대(08:00~20:00) KRX·NXT 통합 수급 수집
- **듀얼 증권사 파이프라인:** 수급 랭킹 집계는 키움 REST API(`ka10058` 거래소 공식 집계 최우선 + `ka10065` 장중 잠정치 보완), 실시간 현재가·등락률은 한국투자증권 통합 체결가 WebSocket(`H0UNCNT0`)으로 역할을 분리해 최적의 속도와 정확도를 확보했습니다.
- **TPS 방어 직렬 속도 제어 큐:** 정규장 거래량 폭발 시에도 키움 API 초당 호출 제한(TPS)을 초과하지 않도록 `220ms` 간격 직렬 큐(`scheduleKiwoomRequest`)와 연속조회(`cont-yn`, `next-key`)를 통해 주체별 **상위 100종목**을 안정적으로 수집합니다.
- **수급 정합성 상호 배타 정제:** 공식 집계와 장중 잠정치 간 괴리로 인해 동일 종목이 매수/매도 목록에 중복 노출되는 현상을 차단(`reconcileInvestorSide`)하고, 기관 5대 주체(금융투자·투신·사모·연기금·보험) 거래대금을 합산해 고가 대형주 누락을 방지합니다.

### 2. 실전 수급 포착 필터 및 시각화
- **쌍끌이 & 3주체 수급 감지:**
  - `쌍끌이 매수` / `쌍끌이 매도`: 외국인과 기관이 동시에 순매수(또는 순매도) 중인 종목 자동 태깅 및 전용 필터 제공
  - `3주체 매수` / `3주체 매도`: 외국인·기관·개인 세 주체가 모두 순매수(또는 순매도)에 참여한 특이 수급 종목 감지
- **PostgreSQL 기반 연속 순매수 추적:** 누적된 일별 수급 데이터를 바탕으로 `2일 · 3일 · 5일` 연속 순매수 종목과 주체별 누적 매수 금액을 조회합니다.
- **순수 개별주 필터링:** `KODEX`, `TIGER`, `스팩` 등 ETF·ETN·SPAC 종목을 원클릭으로 제외할 수 있습니다.
- **직관적인 금액 포매팅 & 체결 하이라이트:** `조 / 억 / 만` 단위 자동 변환(`+1조 1,415억`)과 실시간 체결가 변동 시 행 배경 점멸(Flash) 효과를 지원합니다.

### 3. 무중단 데이터 동기화 및 정산 스케줄러
- **이중 실시간 갱신:** 백엔드 SSE(`/api/stream`) 스트림 푸시와 프론트엔드 15초 백그라운드 폴링을 결합해 탭 절전이나 재연결 시에도 누락 없는 화면 동기화를 보장합니다.
- **자동 DB 정산 (`UPSERT`):** 장중 `08:00~20:05` 동안 5분마다 중간 백업을 수행하고, `15:42`(정규장 마감 잠정치)와 `20:06`·`20:30`(애프터마켓 합산 최종 확정치)에 PostgreSQL에 영구 적재합니다.

---

## 🛠️ 기술 스택

| 구분 | 기술 및 라이브러리 |
| :--- | :--- |
| **Backend** | Node.js `v24` (`--watch`, `--env-file`), Fastify `v5`, `ws`, `node-cron`, `ioredis`, `pg` |
| **Frontend** | React `v19`, Vite `v6`, Tailwind CSS `v4`, Lucide Icons, Server-Sent Events (SSE) |
| **Database & Cache** | PostgreSQL `16` (일별 수급 영구 저장), Redis `7` (토큰 캐싱, 랭킹 스냅샷, Pub/Sub) |
| **Infra & Tools** | Docker Compose, WSL2 (Ubuntu), DBeaver, Redis Insight |

---

## 📂 디렉터리 구조

```text
krx-flow/
├── docker-compose.yaml        # PostgreSQL & Redis 컨테이너 구성
├── schema.sql                 # stocks, daily_investor_flows 테이블 및 인덱스 정의
├── package.json               # 백엔드 의존성 및 실행 스크립트
├── .gitignore                 # .env, *.zip, node_modules 등 민감·빌드 파일 Git 제외
├── .env.example               # 환경 변수 설정 템플릿
├── .env                       # 증권사 API 키 및 DB/Redis 접속 정보 (Git 추적 제외)
├── src/
│   ├── authManager.js         # 키움·한투 REST 토큰 및 WS 접속키 Redis 23h 캐싱
│   ├── kiwoomPoller.js        # 수급 100종목 수집, 기관 거래대금 합산, TPS 큐, DB UPSERT
│   ├── kisWsClient.js         # 한투 통합 실시간 체결가(H0UNCNT0) WebSocket 클라이언트
│   └── server.js              # Fastify REST API, SSE 스트리밍 서버, 시간대별 크론 스케줄러
└── web/
    ├── vite.config.js         # Vite 및 Tailwind CSS v4 설정
    └── src/
        └── App.jsx            # 실시간 3단 수급 대시보드, 필터, 연속 순매수 뷰, 히스토리 모달
```

---

## ⚡ 시작하기 (Quick Start)

### 1. 사전 요구사항
- Node.js `v22` 이상 (내장 `--env-file`, `--watch` 플래그 지원)
- Docker & Docker Compose
- 키움증권 REST API Key/Secret 및 한국투자증권 Open API Key/Secret

### 2. 인프라 컨테이너 실행 (PostgreSQL & Redis)
```bash
docker compose up -d
```

### 3. 환경 변수 설정 (`.env`)
`.env.example`을 복사해 `.env` 파일을 생성한 뒤, 발급받은 증권사 인증키를 입력합니다.
```bash
cp .env.example .env
```

```env
PORT=4000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/krx_flow
REDIS_URL=redis://localhost:6379

# 키움증권 REST API
KIWOOM_BASE_URL=https://api.kiwoom.com
KIWOOM_APP_KEY=your_kiwoom_app_key
KIWOOM_APP_SECRET=your_kiwoom_app_secret

# 한국투자증권 Open API
KIS_BASE_URL=https://openapi.koreainvestment.com:9443
KIS_WS_URL=ws://ops.koreainvestment.com:21000
KIS_APP_KEY=your_kis_app_key
KIS_APP_SECRET=your_kis_app_secret
```

### 4. 백엔드 및 프론트엔드 서버 구동
```bash
# 1) 백엔드 패키지 설치 및 개발 서버 실행 (포트 4000)
npm install
npm run dev

# 2) 새 터미널에서 프론트엔드 패키지 설치 및 실행 (포트 5173)
cd web
npm install
npm run dev
```
실행 후 브라우저에서 **`http://localhost:5173`**으로 접속합니다.

---

## 🔌 주요 API 엔드포인트

| Method | Endpoint | 설명 |
| :--- | :--- | :--- |
| `GET` | `/api/health` | 서버 장 운영 세션, Redis(`PONG`), PostgreSQL 연결 상태 확인 |
| `GET` | `/api/rankings` | 외국인·기관·개인 순매수/순매도 100위 랭킹 및 쌍끌이·3주체 플래그 조회 |
| `GET` | `/api/consecutive` | PostgreSQL 누적 일별 수급 기반 `N`일 연속 순매수 종목 조회 (`?days=3&investor=foreign`) |
| `GET` | `/api/stocks/:ticker/history` | 특정 종목의 일별 종가 및 주체별 순매수 추이 히스토리 조회 |
| `GET` | `/api/stream` | 실시간 체결가(`tick_update`) 및 수급 순위(`rank_update`) SSE 스트림 구독 |
| `POST` | `/api/admin/sync-close` | 수동 수급 수집 및 PostgreSQL 즉시 정산 트리거 |

---

## 🔒 보안 설계 (Security)

- **인증 키 완전 격리:** 증권사 `APP_KEY`, `APP_SECRET`, OAuth 토큰, WebSocket `approval_key`는 백엔드(`.env` 및 서버 내부 Redis)에만 보관되며 클라이언트 번들로는 일절 노출되지 않습니다.
- **SQL 인젝션 방어:** 모든 PostgreSQL 쿼리에 파라미터 바인딩(`$1`, `$2`)과 화이트리스트 분기를 적용했습니다.
- **저장소 민감 정보 차단:** `.gitignore`를 통해 `.env` 및 백업 압축 파일(`*.zip`)의 원격 저장소 커밋을 원천 차단합니다.

---

## 🗺️ 로드맵 (Roadmap)

- [x] **1~3단계:** Docker 기반 PostgreSQL·Redis 구축 및 키움·한투 듀얼 API 인증·스키마 설계
- [x] **4~5단계:** 20초 실시간 폴링·WebSocket 체결가 스트림·SSE 대시보드 1차 구현
- [x] **6단계:** 100종목 확장, 기관 5대 주체 거래대금 합산, 쌍끌이·3주체 매수/매도 감지, 연속 순매수 추적
- [ ] **7단계:** 모바일 홈 화면 설치형 PWA 변환 및 Cloudflare Tunnel 외부 접속 연결
- [ ] **8단계:** 클라우드 서버(Always Free ARM) Docker Compose 기반 24시간 무중단 운영 배포