# Workbench

Workbench is a UK-only bank-reconciliation application for bookkeepers. It ingests GBP bank statement lines, prepares valid accounting candidates in Xero, and waits for verified Xero state before calling a line reconciled.

This repository now contains a runnable React application and a deployable Supabase backend contract. The previous generated HTML prototype has been retired; durable product decisions and live Xero experiment evidence remain in `docs/` and `experiments/xero/`.

## Run locally

Requirements: Node 22+ and pnpm 10.

```sh
pnpm install
pnpm dev
```

Open `http://127.0.0.1:8765`. With no Supabase environment variables, the app uses persistent local demo data. Use **Reset demo** in the rail to return to the seeded state.

```sh
pnpm test
pnpm build
```

The test suite covers statement verification and occurrence/deduplication, entity-aware Xero transitions, transfer-side settlement, reversal behavior, incomplete-company routing, and the invariant that candidate creation produces `prepared`, not `reconciled`.

## Supabase mode

Copy `.env.example` to `.env.local`. At minimum, the browser app needs:

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

The same ignored `.env.local` file may hold the local Supabase CLI credentials and server-only development values documented in `.env.example`. Vite exposes only variables with a `VITE_` prefix to browser code.

Apply the migrations under `supabase/migrations/` in filename order and deploy the functions under `supabase/functions/`.

Server-only secrets belong in the Supabase function environment:

- `COMPANIES_HOUSE_API_KEY`
- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`
- `OPENAI_API_KEY`
- optional `OPENAI_AGENT_MODEL` (defaults to `gpt-5.6`)
- optional `OPENAI_STATEMENT_MODEL` (otherwise uses `OPENAI_AGENT_MODEL`)
- `AGENT_RUNNER_SECRET` (a generated value also stored in Supabase Vault for the minute recovery cron)
- optional `APP_ORIGIN` (defaults to `http://127.0.0.1:8765`)
- a vault-backed implementation of `xero_access_token_for_worker(company_id)`

Never put Xero or Companies House credentials in a `VITE_` variable.

## What is implemented

- portfolio navigation with company as the direct tenancy boundary;
- UK Companies House search boundary and immediate company creation;
- company-scoped membership/invitation tables and RLS;
- passwordless Supabase authentication and session gating;
- incomplete-company Settings default and validated readiness rules;
- one no-mapping statement uploader for GBP CSV, TSV, XLS/XLSX and PDF files, with model extraction, deterministic ledger controls, first-use account confirmation and replay dedupe that preserves genuinely repeated identical lines;
- immutable private source files and a durable, company-fair extraction queue with leases, retries and atomic all-or-nothing commit;
- durable ingestion batches that transactionally enqueue every newly imported line for background analysis;
- one feed per bank account and every canonical line retained until reconciled;
- bank accounts mirrored one-to-one from the connected Xero organisation's active GBP bank accounts, adopting Xero's names, with no manual account creation or mapping;
- BankTransaction, authorised bill/invoice and shared-transfer candidate models;
- local-GUID-first Xero correlation records;
- vault-backed Xero OAuth with rotating refresh tokens;
- owner-only company deletion with exact-name confirmation, per-tenant Xero disconnection and Vault-secret cleanup;
- owner/bookkeeper deletion of an imported statement that removes the canonical lines of its ingestion run and every derived record, refuses while any line still holds a live Xero entity, and reopens the far side of a shared transfer;
- live Xero bank-account, contact and chart-of-accounts discovery for candidate preparation;
- secure server functions for candidate creation and authoritative observation;
- durable Xero-write reservation, native short-window idempotency and marker-based orphan recovery;
- durable company-fair, on-demand Xero observation with leased retries, provider-aware rate-limit deferral and activity-triggered reversal checks;
- parent/GUID, bank-account, amount and posting-date verification before Xero observations can settle lines;
- entity-specific reversal behavior and append-only line events;
- local demo adapter for end-to-end product testing without cloud credentials.
- OpenAI Agents SDK review agent with read-only Xero context, GOV.UK-scoped HMRC research tools, a private editable handbook and raw per-line SDK transcripts;
- company-wide agent chats with a fixed launcher on company pages, a chronological Chats surface, streaming replies, the same private handbook read/write access and read-only Workbench/Xero/HMRC tools;
- one-year Xero-history memory bootstrap and a durable review-only analysis runner; completed analyses use one `needs_you` state while no Xero write tools are available to the agent;
- fair per-company queueing with one active lease per company, FIFO within a company, bounded retries and a shared immutable Xero snapshot per batch;
- fresh create-vs-match lookup across current Xero BankTransactions, authorised open bills/invoices and BankTransfers, with exact existing-entity GUIDs in the typed UI projection;
- private PDF/image evidence uploads into the existing per-line agent thread, with model inspection and a revised recommendation;
- a conventional chronological chat projected from immutable agent runs: analyses, questions, replies, recommendations and workflow events appear once in order, the panel opens at the latest item, and chat/document upload stay fixed at the bottom in every workflow state; post-preparation and post-reconciliation turns preserve the authoritative line state;
- proactive evidence upload on every line, plus automatic agent inspection of supported attachments already on a recommended existing Xero invoice or bank transaction;
- durable document-to-Xero attachment sync after an approved entity is created, including a one-time OAuth scope upgrade for older connections, automatic pending-document recovery and visible retry state for transient failures;

## Deliberate boundaries

The browser cannot write statement lines, workflow statuses or Xero object mappings in Supabase mode. Statement extraction, candidate creation and observation use service-backed Edge Functions. “Open in Xero” is only a link. Bills and invoices are posted as `AUTHORISED`. Transfers link two statement lines to one candidate set and settle each side independently.

Billing is not included. Client document requests remain offline: the bookkeeper obtains a document and uploads it in the line panel. The file is stored privately and inspected in the existing agent thread. If the Xero entity already exists, the analysed file is attached immediately; otherwise it is attached when the recommendation is approved. When an existing Xero match already has evidence attached, Workbench snapshots and passes supported files to the agent before saving its recommendation. Malware scanning remains a production hardening requirement.

## Production work still required

The code makes the remaining integration seams explicit rather than faking them:

1. add email invitation acceptance on top of the implemented authentication/session gate;
2. add labelled evaluation and autonomy-policy tooling around the implemented reviewed match/create pipeline;
3. add an open-banking provider on top of the implemented ingestion-run/analysis queue boundary;
4. add malware scanning and optionally a Xero webhook receiver as a low-latency hint for the on-demand authoritative sync.

## Repository map

- `src/domain/` — pure workflow, readiness and statement-verification rules
- `src/application/` — repository contract
- `src/infrastructure/` — local demo and Supabase adapters
- `supabase/migrations/` — executable Postgres schema, constraints and RLS
- `supabase/functions/` — server-only Companies House and Xero boundaries
- `docs/STATE_MACHINE.md` — company, statement-line and candidate lifecycles
- `docs/SCHEMA.md` — fuller target data model and invariants
- `docs/ARCHITECTURE.md` — system boundaries, sync and failure design
- `docs/AGENT_ARCHITECTURE.md` — implemented shadow agent, artifact format, tools and first real-company findings
- `docs/XERO_CAPABILITY_MATRIX.md` — live UK demo-company experiment results
- `docs/QA_CHECKLIST.md` — automated and manual release checks
- `experiments/xero/` — repeatable Xero capability harness

## Core product decisions

- UK companies and GBP only in v1.
- Company is the tenancy boundary; invitations grant one company.
- Company-name search is the only mandatory creation step.
- Xero, bank source, GBP base currency and VAT answers gate bank-feed use.
- Every real canonical bank line needs valid bookkeeping treatment and eventual reconciliation.
- A line is `prepared` only after a Xero entity exists for it.
- A line is `reconciled` only after newly fetched Xero evidence and immutable fingerprint checks agree.
- A reviewed existing-Xero match is prepared only after server code revalidates the latest agent run, line version and current Xero entity; accepting it never creates a duplicate Xero record.
- A reviewed create recommendation is rebuilt from current server-side Xero contact/account/tax references and rejected if a strong existing candidate has appeared; the browser never supplies the accounting payload. Bills and invoices also require structured document/due dates, and keep the business document number in Xero `InvoiceNumber` separately from the Workbench marker in `Reference`.
- The line panel contains no manual Xero coding UI. It is one chronological chat with rich recommendations inline, compact workflow events, a fixed bottom composer and the raw audit thread available on demand.
- Xero deletions and payment reversals reopen work; they never erase its audit history.
