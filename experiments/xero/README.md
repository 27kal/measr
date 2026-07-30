# Xero capability experiment

This harness tests the assumptions in `docs/ARCHITECTURE.md` against a UK Xero demo company. It uses only Node's standard library and keeps OAuth tokens and raw API captures under the ignored `.xero-spike/` directory.

## Local setup

1. Add the exact redirect URI `http://localhost:8766/oauth/callback` to the Auth Code app in the Xero Developer portal.
2. Put the app's client ID and client secret in the repository-root `.env.local` file. Do not paste the secret into chat.
3. Run `node experiments/xero/xero-spike.mjs serve`.
4. Open `http://localhost:8766/`, choose **Connect UK demo company**, and approve only the demo organisation.

The requested scopes are:

```text
offline_access
accounting.settings.read
accounting.contacts.read
accounting.invoices
accounting.payments
accounting.banktransactions
```

The broad `accounting.transactions` scope is deliberately not used; new Xero apps receive granular scopes.

## Commands

```sh
node experiments/xero/xero-spike.mjs check
node experiments/xero/xero-spike.mjs serve
node experiments/xero/xero-spike.mjs connections
node experiments/xero/xero-spike.mjs baseline
node experiments/xero/xero-spike.mjs prepare
node experiments/xero/xero-spike.mjs observe
```

- `check` verifies local configuration without printing secrets.
- `serve` runs the OAuth callback and connection page.
- `connections` lists connected tenants after OAuth.
- `baseline` captures organisation, account and contact responses locally and prints a small summary.
- `prepare` creates one marked spend, receive, authorised bill, authorised invoice and transfer; writes history markers; and generates two bank-statement CSV fixtures.
- `observe` retrieves every marked object plus its history. For invoices it also fetches every current or previously observed Payment by GUID so `Status` and `IsReconciled` are not inferred from the parent summary.

## Validated result

The 21 July 2026 run created marked spend, receive, authorised bill, authorised sales invoice and bank-transfer candidates; imported six statement lines; accepted all suggested matches in Xero; and observed the resulting API transitions. It then tested Remove & Redo for a spend, bill payment and transfer source.

The durable findings and product consequences are recorded in `docs/XERO_CAPABILITY_MATRIX.md`. Raw timestamped evidence remains in `.xero-spike/raw/` and is deliberately ignored.

## Post-Xero persistence recovery

`recovery-experiment.mjs` exercises the deployed Supabase saga rather than the standalone capability client. Select `EXPERIMENT_KIND=bank_transaction`, `bill` or `transfer`; it creates the corresponding synthetic demo line(s), fails after Xero accepts the candidate, checks the reserved database state, retries, and asserts the recovered mapping(s) plus an idempotent third request.

It requires the linked-project variables in `.env.local`, the target Workbench company's Companies House number and owner email, and a short-lived function secret. The target must be connected to the disposable `Demo Company (UK)` Xero tenant:

```sh
set -a
. ./.env.local
set +a
export XERO_FAILURE_INJECTION_TOKEN="$(openssl rand -hex 32)"
npx supabase secrets set XERO_FAILURE_INJECTION_TOKEN="$XERO_FAILURE_INJECTION_TOKEN" --project-ref "$SUPABASE_PROJECT_REF"
EXPERIMENT_USER_EMAIL="your-owner-email@example.com" EXPERIMENT_COMPANY_NUMBER="12345678" EXPERIMENT_KIND="bank_transaction" node experiments/xero/recovery-experiment.mjs
EXPERIMENT_USER_EMAIL="your-owner-email@example.com" EXPERIMENT_COMPANY_NUMBER="12345678" EXPERIMENT_KIND="bill" node experiments/xero/recovery-experiment.mjs
EXPERIMENT_USER_EMAIL="your-owner-email@example.com" EXPERIMENT_COMPANY_NUMBER="12345678" EXPERIMENT_KIND="transfer" node experiments/xero/recovery-experiment.mjs
npx supabase secrets unset XERO_FAILURE_INJECTION_TOKEN --project-ref "$SUPABASE_PROJECT_REF"
unset XERO_FAILURE_INJECTION_TOKEN
```

Always unset the secret immediately after the run. The Edge Function additionally requires an owner session and tenant name exactly `Demo Company (UK)` before recognising the test header.

## Safety boundary

- Use a Xero demo company only.
- The browser handles Xero login and consent; the harness never receives a password or MFA code.
- Tokens are stored with owner-only permissions in `.xero-spike/token.json`.
- Raw API responses are written to `.xero-spike/raw/` and are not committed.
- Mutation commands add a `WB-XSP-...` marker to every object they create.
- The recovery experiment creates a visible synthetic Workbench line and Xero object; retain it only in the disposable demo environment as test evidence.
