# Agent Fox: Conversational Finance Agent

> Agentic query workflow orchestrated with LangGraph and a tool-using
> conversational AI agent.

Agent Fox handles everything around your money in plain conversation. It
**plans** (monthly spend against your budget), **tracks** (every rupee across
PhonePe, Wallet, cash, and bank with running balances), and **lodges expenses**
(`spent 500 on groceries via phonepay` → reviewed → written to your real Excel
ledger). It reads the sheet, computes deterministically, and answers like a
person.

**Try asking:**

- **Plan:** `plan my budget for this month end to survive` · `plan my expenses this month` · `my bank balance is very low, what can I cut this week?`
- **Track:** `where did I overspend this month?` · `how much did I spend this month?` · `chart my spending`
- **Lodge:** `spent 500 on groceries via phonepay`

Two frontends serve one brain: a **React web app** and a **Discord bot**
(DMs). Both drive the identical LangGraph workflow; neither knows about the other.

Full system diagram (frontends, API, LangGraph nodes and loopbacks, Azure AI,
tools, storage): [`architecture.mmd`](./architecture.mmd)

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [The Three-ID Contract](#2-the-three-id-contract)
3. [LangGraph Deep Dive](#3-langgraph-deep-dive-nodes-edges-state)
4. [Storage & Sessions](#4-storage--sessions)
5. [LLM Layer](#5-llm-layer-deterministic-core-conversational-shell)
6. [Frontends: React + Discord](#6-frontends-react--discord)
7. [Project Record](#7-project-record-safety-history-testing-next)
8. [Setup & Run](#8-setup--run)
9. [Repository Map](#9-repository-map)

---

## 1. System Architecture

```
 ┌──────────────┐                              ┌──────────────┐
 │ REACT  :5173 │── POST /api/chat ───────────▶│              │
 └──────────────┘                              │   NESTJS     │
                                               │   API :3009  │
 ┌──────────────┐  Discord gateway (WS out)    │              │
 │ DISCORD bot  │── messageCreate ────────────▶│ ChatController│──┐
 └──────────────┘  (no HTTP, no public URL)    │ WhatsApp*     │  │  *parked
                                               │ DiscordController  │
                                               └──────────────┘  │
                                                        │        │
                                    ┌───────────────────┘        │
                                    ▼                            ▼
                         WorkflowService.execute() ◀── channel adapters
                           lock → cancel? → registry → tracking → graph
                                    │
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
               PostgreSQL      Redis 6380     S3/LocalStack:4566
              :5433 config    checkpoints    Budget_2026.xlsx
              + tracking      locks/signals  FINANCIAL TRUTH
```

**Module responsibilities** (`apps/api/src/`):

| Module | Owns | Never touches |
|---|---|---|
| `workflow/` (WorkflowService, registry, tracking) | Orchestration: locks, cancel checks, DB routing, metering | Graph topology details |
| `workflow/expense/` (5 files, no module) | The expense graph: state, nodes, edges, config | Other workflows' state |
| `workflow/chat/` | React HTTP adapter + idempotency cache | Workflow internals |
| `discord/` | Discord DM adapter (gateway, embeds, buttons, files) | Anything outside `discord/` |
| `tools/` | Deterministic ops (`log/query/generate_chart`) behind a DB allow-list | LLM guessing |
| `llm/` | Intelligence: classify/extract/parse/interpret/generate + prompts | Money math |
| `langgraph/` | Official `RedisSaver` checkpointer, retry policies | Domain logic |
| `database/` | Prisma client + seeds | Business rules |
| `apps/web/` | React UI, thread persistence, recovery | Backend internals |

**Hard rules (enforced, not aspirational):** no `eval`/`new Function` anywhere;
no LangGraph `interrupt()/resume()` — waiting is checkpointed state, not
suspended execution; DB *registers* (workflows, tools, prompts), code
*implements* (no topology or executable logic in rows); prompts live in
`llm/prompts/*.prompts.ts`, generic and meaning-based, never per-query examples.

---

## 2. The Three-ID Contract

| ID | Meaning | Source | Scope |
|---|---|---|---|
| `workflowId` | Which workflow definition | `agent_workflows.id` | Workflow type |
| `threadId` | Which conversation | Backend creates; client persists (React: `localStorage`; Discord: `dc_<userId>`) | LangGraph checkpoint key — thread A never leaks to thread B |
| `requestId` | Which request | Client generates per message (web UUID; Discord message id; WhatsApp `wamid`) | Idempotency boundary + lock owner + cancel scope |

First request sends no `threadId` → backend mints one → client stores it.
Every retry reuses its `requestId` → byte-identical cached reply, zero re-execution.

---

## 3. LangGraph Deep Dive (nodes, edges, state)

One invoke per HTTP/message turn, always entering at `START`. "Resuming" is a
fresh invoke that reads the checkpointed `workflowMode` and routes accordingly —
there is no suspend/resume anywhere in this codebase.

### 3.1 Entry + classification

```
START → routeFromStart ─┬─ AWAITING_CLARIFICATION → parse_clarification (resume)
                        ├─ PENDING_CONFIRMATION   → parse_edit_or_confirm (resume)
                        ├─ AWAITING_USER_CLARIF.  → classify_intent (resume)
                        ├─ bare "yes" + broaden offer → broaden_previous → retrieve…
                        └─ fresh ────────────────────→ classify_intent
classify_intent → routeByIntent ─┬─ combo (2+ subRequests) ─▶ §3.4
                                 ├─ NEW_TRANSACTION_BATCH ───▶ §3.2
                                 ├─ ANALYTICAL_QUERY ────────▶ §3.3
                                 ├─ EDIT_OR_CONFIRM ─────────▶ §3.2 (confirm path)
                                 └─ UNKNOWN ─────────────────▶ request_user_clarification
```

`classify_intent` runs the intent classifier (confidence-gated at 0.7 —
below it, forced UNKNOWN, never acted on), segments combinational messages,
clears stale per-turn output (error/status/chart/note), and abandons diverted
clarifications back to IDLE. `routeFromStart` also owns STOP-miss handling,
cancel-phrase exits, topic-switch diverts (questions asked mid-wait get fresh
classification, batch preserved), and broaden-consent routing.

### 3.2 Transaction path (log → confirm → write)

```
parse_transactions → validate_transaction_data
  ├─ COMPLETE ────▶ present_batch ──▶ END (wait: confirm/cancel/edit)
  └─ MISSING_INFO → request_clarification ──▶ END (wait: answer)
       ▲ resume ▼
  parse_clarification → merge_with_pending → validate (bounded loop)
  reject_incomplete_transaction ──▶ END (budget exhausted, explained)

parse_edit_or_confirm ─┬─ CONFIRM ─▶ write_batch ─┬─ success ─▶ END (receipt)
                       │                          └─ + deferred subs ─▶ answer_deferred_subs
                       ├─ EDIT ────▶ merge_edits → present_batch (re-present)
                       └─ CANCEL ──▶ clear_batch → END (full reset)
```

- **Slot-filling without amnesia:** per-item validation (each batch line
  checked against its own line — distribution is not ambiguity), questions
  targeting one `(field, row)`, merges landing on that row only, establishment
  memory (home-line statements + earlier answers + credit signals) protecting
  settled slots from later bare replies.
- **Batches survive extraction:** segment-fallback re-parses dropped lines
  independently; schema failure sanitizes rows to incomplete-but-valid
  instead of nuking siblings. A missing amount is clarification work, not corruption.
- **Edits** are parsed (`description/amount/mode/category/tag`), categories
  canonicalized deterministically, unknown words ignored, `none` clears.

### 3.3 Query path (ask → read → answer)

```
interpret_query → retrieve_transactions → validate_query_result
  ├─ SUFFICIENT ─▶ generate_answer → validate_answer ⇆ regenerate_answer (≤2) → END
  ├─ TOO_BROAD ──▶ transform_query (newest-100 cap, disclosed) → retrieve…
  ├─ ZERO ───────▶ honest "none in scope — broaden or leave it?" → END
  └─ chart ──────▶ build_chart → END (PNG + text)
```

- **Reads are deterministic:** filters/aggregation (SUM/COUNT/AVERAGE) execute
  in code; per-mode subtotals precomputed; the LLM phrases, never computes.
- **Balances are authoritative:** sheet cards via `getCurrentBalances()`, served
  as a mandatory lead sentence and figure-checked by the validator. Balances-only
  payloads carry nothing else. Sums are never reported as balances.
- **Zero hits are honest** (never silent widening). Consent broadens via
  keyword carry, bare `yes` (tracked offer + widenable scope), or a fresh window.
- **Answers follow the question:** totals for how-much, enumerated rows for
  show-me, descriptions-only when restricted, every part + combined close for
  multi-part questions. Narration is fused (one clause per row, each fact once);
  the validator checks substance paraphrase-tolerantly; the regenerator speaks
  forward (requirements, never backstage talk).

### 3.4 Combinational turns (split → sequence → combine)

```
routeByIntent ─┬─ mixed (txn + analytical) ─▶ start_combination
               │     ├─ txn text re-messaged ─▶ normal §3.2 flow (waits work)
               │     └─ analytical subs ──▶ pendingSubs ──▶ (after write)
               │                                    answer_deferred_subs (fresh reads)
               └─ all-analytical ─▶ answer_subqueries (per-scope retrieve+answer+chart)
```

The classifier segments multi-job messages into `subRequests`
(`MAX_COMBO_SUBS: 4`, item-lists never split, extras folded not dropped).
Transaction-first ordering keeps post-write reads fresh (receipt prepended);
each part is labeled by quoting its sub-question; UNKNOWN parts get ask-back
notes, never silent drops. Single-request turns take the classic paths untouched.

### 3.5 Guardrails + loopbacks (the complete safety net)

| Guardrail | Where | What it stops |
|---|---|---|
| Confidence gate (0.7) | `classify_intent` | Low-confidence gibberish entering any flow |
| Clarification budgets (3 attempts / 6 rounds, failed-rounds counting) | merge/validate edges | Infinite ask-loops; junk terminates explained |
| Regen/transform caps (2 / 3) | answer/query routers | Vague-answer and broad-query spirals |
| Row-enumeration cap (50) | answer validator | 200-row context blowups |
| Combo fan-out cap (4) | classify | Per-turn LLM explosion |
| Schema sanitize (not nuke) | `parse_transactions` | Sibling loss on incomplete rows |
| Per-turn output clearing | entry nodes | Stale chart/error/note haunting later turns |
| Thread lock (request-owned, TTL + renewal) | `WorkflowService` | Concurrent same-thread races |
| Idempotency cache + committed-write keys | chat adapter + `write_batch` | Double delivery, double writes |
| S3 compare-and-swap (`IfMatch`) | `log_transaction` | Lost updates across writers |
| Overdraft projection | `log_transaction` | Negative-driving debits (refuse + keep batch) |
| STOP (runs + waits) / cancel (full reset) | boundary + nodes | Unkillable flows, resurrection bugs |
| Allowlist (Discord), HMAC guard (WhatsApp, parked) | channel adapters | Strangers, forged webhooks |

**Loopbacks in the graph:** clarification answer→merge→validate (bounded);
edit→merge→re-present; broaden-consent→retrieve; transform→retrieve (capped);
regenerate→validate (≤2); deferred-subs after write. Every cycle carries a
counter and a terminal exit — no unbounded edges exist.

### 3.6 State, edges, config

- **State** (`expense.state.ts`): request/thread/message identity, transaction
  rows (`raw/validated/pending`), clarification context + budgets + answer
  trail, sub-requests + deferred subs + broaden offer, query
  filters/aggregation/retrieval/answer fields, chart image, metering counters —
  all replace-reducer channels with safe defaults.
- **Routers** (`expense.edges.ts`): `routeFromStart`, `routeByIntent` (incl.
  combo branch), validation/query/edit/confirm/answer/write routers. All
  deterministic predicates — no LLM in routing, ever.
- **Config** (`expense.config.ts`): every bound above, plus timeouts and TTLs.
- **Metering:** every node folds real LLM/token/tool counts into checkpointed
  metadata; API reports measured per-request deltas, never estimates.

---

## 4. Storage & Sessions

| Store | Holds | Never holds |
|---|---|---|
| **PostgreSQL** (`agent_workflows`, `tool_definitions`, `flow_trackings`, Prisma seeds) | Workflow/tool registration + config, execution tracking (real tokens/model) | Checkpoints, conversation, money |
| **Redis** (official `RedisSaver`, locks, signals) | Checkpoints keyed by `threadId`, `agent-fox:lock:{thread}` (request-owned, TTL + renewal), `agent-fox:cancel:{thread}:{request}`, idempotency markers | Definitions, financials |
| **S3 / LocalStack** (`agent-fox-budget/Budget_2026.xlsx`) | THE financial truth: month sheets (PhonePe/Wallet), `CASH TRACKER` (Money/Bank), `TERMINOLOGY` word lists + balance cards | Anything conversational |

**Write discipline:** download → mutate in memory → conditional upload
(`IfMatch` base ETag). Concurrent writers: one wins, the loser fails safe with
a retryable message — no partial writes, ever. LocalStack persists via
`PERSISTENCE=1` + volume.

**Sessions:** React persists `threadId` in `localStorage` and recovers via
`GET /api/chat/state/:threadId`; Discord threads (`dc_<userId>`, rotated on
"new chat" with checkpoint wipe + own-message evaporation) resume from Redis
after restarts. STOP ends runs *and* waiting states (transcript kept).

**Local ports:** API `:3009` · web `:5173` · Postgres `:5433` · Redis `:6380` · LocalStack `:4566`.

---

## 5. LLM Layer (deterministic core, conversational shell)

Azure AI (`gpt-5-mini`), structured JSON-schema calls only, temperature fixed.
Services: intent classifier (+combinational splitter), transaction extractor
(+segment fallback), edit parser, query interpreter (`wantsDetails`,
`wantsBalances`), answer generator/regenerator, schema validator, category
inference (superseded by workbook rules).

**The split that governs everything:** code computes (validation, totals,
balances, routing, guards); the model drafts text within validator-checked
contracts; prompts are generic and meaning-based (category kinds, answer
shapes, divert rules) — per-query examples are banned by policy. Clarifying
questions are deterministic templates grounded in the user's own words.

---

## 6. Frontends: React + Discord

**React (`apps/web/`, Vite + TS):** chat UI with review cards (confirm/cancel
disable while loading), workbook download/upload buttons, `useChat`/`useThreadId`
hooks, recovery-on-mount, `ChatErrorBoundary` + defensive rendering (a render
throw can never blank the page again).

**Discord (`apps/api/src/discord/`, DM-only):** gateway client (DM +
MessageContent intents, Channel/Message partials), fail-closed allowlist
(`DISCORD_ALLOWED_USER_IDS` — strangers get silence), warn-only boot (missing
token never crashes the backend). Parity kit: STOP strings, idempotency
replay, busy replies, chart PNG attachments, 2000-char newline chunking,
typing loop, partial fetch. Review cards render as embeds with real
Confirm/Cancel buttons (+ text fallback); `/commands` menu
(download/upload/log/ask/new-chat); workbook up/download reuse the exact
`S3Service` methods; "new chat" rotates threads with checkpoint wipe +
own-message evaporation. One import line in `app.module.ts` is the only
touchpoint outside `discord/`.

---

## 7. Project Record (safety, history, testing, next)

- Confirm-before-write; batch-less confirms can never write.
- Credits need user-stated signals or explicit confirmation.
- Overdrafts refused with figures; batch kept for edit/cancel.
- Empty batches refused; idempotency keys make replays safe.
- Cancel clears; STOP ends runs and waits.
- Categories shown and editable at confirm.
- Clarifications ask only genuinely-missing slots, one item at a time.
- Zero-hit queries answer honestly; scope widens only on consent.
- Combinational turns answer every part, then close combined.
- Stale state (error/chart/note) cleared at every query entry.
- Spec review (`Knowledge/claude review.md`) found drift, CAS, STOP and DTO gaps — all fixed and verified live.
- TC1–TC53 in `TEST_USECASES.md`, each replayed live; Discord parity table in `Knowledge/discord_setup.md`.
- Next (proposed): Telegram adapter → Meta publish track → learned category map → multi-user hardening → hosted deploy.

---

## 8. Setup & Run

**Prerequisites:** Node 22+, Docker, (Discord) a bot token.

```powershell
# 1. Infrastructure
docker compose up -d                      # postgres :5433, redis :6380, localstack :4566

# 2. Seed database (first time / after reset)
npx tsx prisma/seeds/index.seed.ts        # workflows, tools (self-healing)

# 3. Seed the workbook (first time only)
curl.exe -X PUT --data-binary "@budgetfile/Budget_2026.xlsx" http://localhost:4566/agent-fox-budget/Budget_2026.xlsx

# 4. Backend (clean rebuild discipline — always wipe dist first)
Remove-Item -Recurse -Force apps\api\dist
npm run build --workspace=apps/api
npm run start --workspace=apps/api        # :3009  (dev: npm run dev:api)

# 5. Frontend
npm run dev --workspace=apps/web          # :5173
```

**Environment (`.env`, git-ignored):** `DATABASE_URL`, `REDIS_URL` (+TTL/lock
tunables), LocalStack S3 keys, `AZURE_AI_*`, Discord bot triple
(`DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_ALLOWED_USER_IDS` —
DM mode needs nothing else).

**Discord bot setup:** Developer Portal → app → Bot → Reset Token →
`.env`; enable **Message Content Intent**; Developer Mode → copy your user ID
→ allowlist; run the branch backend; DM the bot.

**Port discipline:** one owner per port — human runs `:3009`, agent sandboxes
use `:3021`+ with probe S3 keys (deleted afterwards).

---

## 9. Repository Map

```
Agent-Fox/
├── README.md                      ← you are here
├── architecture.mmd               ← full system + LangGraph diagram (Mermaid)
├── TEST_USECASES.md               ← TC1–TC53 evidence log
├── Knowledge/                     ← specs, discord design + parity table,
│                                     phase reports, audits, mermaid flow
├── budgetfile/Budget_2026.xlsx    ← canonical seed (S3 is the live truth)
├── docker-compose.yml             ← postgres, redis, localstack
├── prisma/                        ← schema, migrations, seeds (self-healing)
├── tests/                         ← fixtures + scenario tests
├── apps/
│   ├── api/src/
│   │   ├── main.ts / app.module.ts
│   │   ├── database/  langgraph/  llm/ (+prompts/)  tools/
│   │   ├── workflow/
│   │   │   ├── workflow.service.ts / registry / tracking / storage / excel
│   │   │   ├── chat/              ← React HTTP adapter + idempotency
│   │   │   └── expense/           ← the graph (state/nodes/edges/config)
│   │   └── discord/               ← DM adapter (config/service/listener/module/types)
│   └── web/src/                   ← React app (chat, hooks, recovery, boundary)
└── .env                           ← git-ignored (see Setup & Run)
```