# QA checklist

## Automated gates

```sh
pnpm test
pnpm build
```

The current suite must prove:

- replaying a CSV/PDF/spreadsheet creates no duplicate canonical lines while two identical occurrences in one statement remain two lines;
- legacy-imported lines deduplicate semantically even when their retired hash format differs;
- invalid or incomplete statement extraction creates no canonical bookkeeping lines;
- statement identity does not depend on a model-extracted running balance, while balance continuity remains a validation control;
- a candidate creates `prepared`, never `reconciled`;
- BankTransactions settle only from a matching verified Xero observation;
- authorised bills/invoices settle only through a matching reconciled Payment and return to `prepared` after payment reversal;
- transfer sides settle independently and shared-transfer deletion reopens both;
- production observation selects settled as well as active candidate sets so Xero reversals can be discovered;
- incomplete companies open Settings and cannot open Reconcile;
- recovery lookup paths, accounting fingerprints and ambiguous-marker rejection are covered by pure tests.
- the new-candidate validator rejects stale Xero references and newly appeared duplicate candidates;
- the line panel has no manual account/contact/type form and continues the saved agent thread.
- Xero-ledger normalization preserves bank-account identity and signed amounts for BankTransactions, Payments and both BankTransfer sides;
- only a globally one-to-one exact account/amount/date reconciliation is linked automatically; duplicate, nearby-date and already-mapped movements remain ambiguous;
- line analysis and accepted writes run the reconciliation preflight before the agent or any Xero mutation.
- document uploads accept only PDF/PNG/JPEG/WebP up to 10 MB, continue the exact saved line thread with actual file input, and persist a private reference rather than base64 in raw history;
- an approved create attempts every analysed document against the stored Xero GUID; a connection missing `accounting.attachments` offers one Xero reauthorisation and then retries pending documents automatically, while transient failures remain independently retryable without recreating the entity.
- document upload returns before agent inference; the line panel polls background status, prevents concurrent thread edits, and renders timeout/failure/retry feedback only inside Supporting evidence.
- a company-chat first message creates one company-scoped chat, navigates to Chats, preserves subsequent turns in the same private artifact and never exposes an operational/Xero mutation action.

## Local product pass

Start `pnpm dev` and test at 1440×900 and 1024×768.

1. Home shows ready and incomplete companies directly under the user account.
2. Add company → search `Northstar` → choose a UK result.
3. Verify the company exists immediately and opens Settings.
4. Verify Reconcile remains disabled until Xero, a bank/CSV source, GBP and VAT requirements are complete.
5. Add a bank account and upload a CSV, TSV, spreadsheet or PDF without mapping columns. Verify the UI shows detected account, period, transaction count and proof level; confirm the first file, then replay it and require `0 new` with no new agent jobs.
6. Upload a malformed or partial statement and verify the failure appears in the upload context and no statement line is committed.
7. Open an unprepared line and verify there is no manual candidate/account/contact form.
8. Analyse it, then verify the panel shows only the agent recommendation action and a same-thread message box.
9. Send a follow-up and verify the revised recommendation and user message remain in the same panel/thread.
10. For a complete recommendation, choose Use this recommendation and verify the line becomes Prepared, never directly Reconciled. Bills/invoices must say AUTHORISED.
11. Open a prepared line and follow Open in Xero; the local state must not change from navigation.
12. In demo mode, use Refresh from Xero and verify prepared lines reconcile only through the observation boundary.
13. Select the current/reserve accounts and verify counts describe only the selected bank account.
14. Check that no line action removes a real bank line from bookkeeping.
15. Reconcile an untouched imported line directly in Xero, refresh Workbench, and verify it moves directly to Reconciled without an agent thread or Xero write.
16. Create two same-account/same-amount candidates on the same or nearby date and verify Workbench shows an amber in-panel reconciliation review instead of choosing or creating a record.
17. Open a recommendation that requests an invoice, upload a real supplier PDF/image and verify the recommendation is revised in the same thread with document evidence.
18. Approve the revised create, verify the line becomes Prepared and the document appears on the exact Xero entity without another user action. With an older token missing `accounting.attachments`, verify one reconnect automatically syncs the pending document. For a transient attachment failure, verify the in-panel retry succeeds without another entity.
19. From Reconcile and Settings, send a message through the fixed company-chat launcher. Verify it navigates to Chats, streams one response, opens at the latest turn and remains in the past-chat list after reload. Open a statement-line panel and verify its own composer replaces the global launcher.

## Accessibility pass

- Tab order reaches the rail, company cards, search, settings controls, feed filters/rows and side-panel controls.
- Enter/Space activate buttons; focus is visible.
- Inputs and selects expose accessible names.
- Dialog/panel close controls have text alternatives.
- Statuses include text and do not rely on colour alone.
- Long names and references do not obscure amounts or actions.

## Supabase contract pass

- unauthenticated requests return no company data;
- a member of company A cannot read/write company B data;
- only owners can manage company invitations/memberships;
- browser roles cannot insert candidate sets, Xero objects, line events or outbox work;
- direct browser writes cannot set `prepared` or `reconciled`;
- one transfer candidate set requires exactly one source and one destination membership;
- transfer direction and Xero accounts are derived server-side from equal/opposite statement lines on the same date; browser-supplied account IDs are not trusted;
- candidate memberships cannot cross companies or alter the line amount/account/posted-date fingerprint;
- observation result rows, candidate state and audit events commit atomically;
- external Xero retry does not create a second active candidate attempt;
- Xero preparation reserves its marker, request fingerprint and one-UUID idempotency key before the external write;
- a changed accounting request cannot reuse a live reservation;
- the post-Xero local commit stores GUIDs, line transitions, events and outbox work atomically;
- payment/account/amount mismatch remains Prepared and emits review evidence;
- webhook replay and repeated on-demand synchronization are idempotent.
- repeated identical observations do not increment line versions or append duplicate line events;
- observation leases expire safely, retry with backoff and allow at most one active observation per company;
- explicitly queued companies are dequeued fairly; an empty recovery wake performs no Xero calls;
- page entry, explicit refresh and return from an Open in Xero link enqueue a coalesced company sync;
- a Xero `Retry-After` cooldown is preserved across page-entry and explicit-refresh requests without consuming retry attempts;
- recent settlements are checked on demand, while older settlements join the next activity-triggered full sweep after 24 hours.
- company-chat rows and raw artifacts cannot be read across company membership boundaries; concurrent sends to one chat allow only one active run, and the database latest pointer never advances before the corresponding private artifact exists.

## Live integration pass

Use a disposable UK Xero organisation and the harness in `experiments/xero/`.

- spend/receive BankTransaction: `AUTHORISED`, then `IsReconciled=true` after Xero reconciliation;
- bill/invoice: created `AUTHORISED`, then parent `PAID` plus exact Payment `AUTHORISED`/reconciled;
- bill/invoice create payloads include both `Date` and required `DueDate`;
- transfer: source/destination flags observed separately;
- deployed transfer: persist BankTransfer plus both returned BankTransaction GUIDs, prove source-only partial settlement, full settlement, and atomic two-line invalidation after Remove & Redo;
- Remove & Redo: Payment reversal returns parent flow to Prepared; BankTransaction/BankTransfer deletion invalidates the attempt;
- GUID, marker channel, bank account, signed amount and date evidence is stored for each transition.
- a local bank account must be explicitly mapped to its Xero bank account before preparation;
- live contacts and chart-of-accounts options load through the authenticated server boundary, not from embedded demo values.
- upload a real document, approve its recommendation, fetch the created Xero entity's Attachments collection and verify filename, content length and attachment GUID; repeat the sync and require no duplicate upload;
- inject a failure after Xero creation and before local commit; verify `recovery_needed`, zero local Xero objects and an unchanged line, then retry and require exactly one marker match, one local object, `committed`, and `prepared`;
- repeat the successful request and require the same candidate ID with no additional Xero write;
- an automated-browser failure to render Xero Bank Reconciliation is recorded as a test-harness constraint only, never as a Xero capability or architecture constraint.
