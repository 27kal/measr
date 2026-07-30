# Xero capability matrix

Validated on 21 July 2026 against a UK Xero demo company with marker `WB-XSP-20260721-357EB3`. The repeatable harness is under `experiments/xero/`; tokens, manifests and raw responses stay in ignored `.xero-spike/` storage.

## Verdict

The core product loop is viable: Workbench can create the tested Xero candidates, retain a durable local GUID mapping plus Xero-side correlation markers, send the bookkeeper to Xero, and detect both reconciliation and later reversal from Accounting API state.

The most important model correction is that reverse transitions are entity-specific. A removed payment preserves its authorised bill/invoice, while Remove & Redo deletes a spend/receive BankTransaction or an entire BankTransfer. Transfers also require one shared candidate set linked to two independently settling statement lines.

## Tested surface

| Capability | Result | Evidence |
|---|---|---|
| OAuth auth-code flow and refresh token | Pass | Granular settings, contacts, invoices, payments and bank-transaction scopes connected one UK demo tenant. |
| UK/GBP tenant and account discovery | Pass | Demo organisation reported country `GB`, base currency `GBP`, and two GBP bank accounts. |
| Manual statement import | Pass | Five current-account lines and one savings-account line imported from generated CSV; Reference mapping preserved and Xero reported zero duplicates. |
| Create spend and receive money | Pass | Both returned `AUTHORISED` BankTransaction GUIDs. |
| Create bill and sales invoice | Pass | Both returned `AUTHORISED` Invoice GUIDs with exact totals. |
| Create bank transfer | Pass | Returned the BankTransfer GUID and distinct source/destination BankTransaction GUIDs. |
| Xero suggested matching | Pass | Cash Coding showed exactly one suggested match for each of the six imported statement lines; the reconciliation screen offered `OK` for each. |
| Reconciliation observation | Pass | Entity-specific transitions below were read back through the Accounting API after each Xero action. |
| Reverse observation | Pass | Remove & Redo semantics below were read back through the API and object histories. |
| Post-Xero persistence recovery | Pass | An injected failure after Xero accepted a BankTransaction left a durable reservation with zero local object rows; retry found the exact marker, reattached one GUID and committed atomically. |

## Forward lifecycle

| Candidate | Prepared state | Xero action | Observed state |
|---|---|---|---|
| Spend BankTransaction, £123.45 | `AUTHORISED`, `IsReconciled=false` | Accept suggested match | Same GUID and `AUTHORISED`; `IsReconciled=true`; `Reconciled` history event. |
| Receive BankTransaction, £234.56 | `AUTHORISED`, `IsReconciled=false` | Accept suggested match | Same GUID and `AUTHORISED`; `IsReconciled=true`; `Reconciled` history event. |
| Bill, £345.67 | Invoice `AUTHORISED`, due £345.67 | Accept suggested match | Parent `PAID`, due £0; new Payment GUID, `AUTHORISED`, `IsReconciled=true`, exact bank account/amount/date. |
| Sales invoice, £456.78 | Invoice `AUTHORISED`, due £456.78 | Accept suggested match | Parent `PAID`, due £0; new Payment GUID, `AUTHORISED`, `IsReconciled=true`, exact bank account/amount/date. |
| Transfer, £67.89 | BankTransfer `AUTHORISED`; both flags false | Accept source line only | `FromIsReconciled=true`, `ToIsReconciled=false`. |
| Same transfer | Source true, destination false | Accept savings destination line | Both flags true. |

This supports `prepared → reconciled` only from fetched Xero evidence. Opening Xero or clicking the Workbench link remains navigation-only.

## Reverse lifecycle

| Tested action | Observed API result | Product transition |
|---|---|---|
| Remove & Redo reconciled spend | BankTransaction became `DELETED`, `IsReconciled=false`; history added `Unreconciled`, `Voided`, `Deleted`. | Invalidate the old candidate set and move the line to `needs_you`. Re-creation is a new attempt/GUID, not the old candidate returning to Prepared. |
| Remove & Redo bill payment | Payment became `DELETED`, `IsReconciled=false`; bill returned `PAID → AUTHORISED`, due amount restored; history added `Payment Reversed`. | Return line to `prepared` when the same parent document and all fingerprints remain valid. |
| Remove & Redo transfer source | Entire BankTransfer became `DELETED`; both side flags became false even though only the source row was selected. | Atomically invalidate the shared candidate set and both linked statement lines. |

Receive-money deletion and sales-invoice payment reversal were not repeated because they use the same tested object classes and reverse mechanisms as spend money and bill payment respectively.

## Correlation channels

The local `(tenant_id, object_type, xero_object_id)` mapping is authoritative. Xero markers are recovery and diagnostic evidence.

| Object | Confirmed channels | Notes |
|---|---|---|
| BankTransaction | `Url`, Reference, History note | All three survived reconciliation and deletion. Only use Reference when it is not business-owned. |
| Bill/invoice | `Url`, Reference, History note | All three survived payment creation/reversal. Invoice number remains Xero/business-owned. |
| Payment | Local GUID discovered from the parent Invoice | Fetch the Payment endpoint to obtain `IsReconciled`; the nested Invoice payment summary did not expose that flag. |
| BankTransfer | Reference; History note via returned source BankTransaction | No transfer `Url` channel was available. Store transfer plus both returned transaction GUIDs. |

## Architecture consequences

1. Model `candidate_sets ↔ statement_lines` as many-to-many. A transfer candidate links source and destination lines, and each line follows its own side flag.
2. Persist Payment objects discovered during observation, not just objects Workbench created.
3. Store entity-specific reconciliation state rather than relying on one nullable `is_reconciled` column.
4. Keep deleted/reversed Xero GUID mappings for audit. Replacement candidates get a new attempt and idempotency key.
5. Poll active and recently settled candidates even with webhooks. Xero-side changes are authoritative and can reverse prior states.
6. Treat Xero history as audit support, not the state predicate; current object fields drive transitions.

## Limits and remaining unknowns

- The ordinary Accounting API cannot read or reconcile unreconciled bank statement lines. It also does not expose a direct statement-line ID join from the reconciled Payment/BankTransaction. Verification is therefore the linked object state plus strict account, amount, date, parent and marker checks.
- Partial payments, batch payments, prepayments, overpayments, credit notes, multi-currency and split matches were not exercised. They should be added as adapter capability tests only when included in the delivery scope.
- Xero's Bank Reconciliation screen returned `Unable to load data` in the automated in-app-browser session while the same screen loaded in the user's normal Safari session. Treat this only as an automation-session constraint: it is not a Xero product limitation and has no product-architecture consequence.
- The experiment used manual CSV import to create statement lines because ordinary apps cannot import them through the Accounting API; production lines still come from the open-banking provider or Workbench CSV ingestion.

## Xero write-recovery matrix — 23 July 2026

The deployed preparation path was exercised with synthetic spend, bill and transfer lines in BORINGBITS LIMITED and the connected UK demo tenant. Every case injected a failure after Xero acceptance but before the atomic local commit, required marker-based recovery, and then repeated the same request a third time.

| Candidate | Candidate set | Recovered Xero objects | Final local state |
|---|---|---|---|
| £1.37 BankTransaction | `40597d91-568b-45b3-aa13-7cca28d8ca22` | BankTransaction `55d6a2b7-0e7c-4f67-90a4-5cfcad1b999d` | one line `prepared`; set `active/committed` |
| £1.38 authorised bill | `81c4b483-696b-40f7-9b7b-847b2478bae4` | Invoice `0ba387ed-bfa5-40f4-b846-e03709fde419` | one line `prepared`; set `active/committed` |
| £1.39 BankTransfer | `6eb8e6ac-afa8-4c1a-a888-6dd502037521` | BankTransfer `b2e2d490-fd99-4ce4-bba5-5cbc68d2d9dd`; source `2124b876-bd5c-49ab-aaad-3915da0fb622`; destination `e83e0366-a0a1-401e-bb27-4b568c28cb84` | both lines `prepared`; shared set `active/committed` |

Detailed observations:

- Workbench first reserved candidate `40597d91-568b-45b3-aa13-7cca28d8ca22`, marker `WB-D84DBD31D92E4AB58BCE-A1`, its immutable request fingerprint and a persisted Xero idempotency key;
- Xero rejected the documentation's suggested concatenation of four UUIDs because the resulting 144-character `Idempotency-Key` was too long; Workbench now uses one UUID and enforces a 128-character database ceiling;
- after the corrected request created BankTransaction `55d6a2b7-0e7c-4f67-90a4-5cfcad1b999d`, the harness deliberately failed before `commit_xero_preparation`;
- the candidate remained `building/recovery_needed`, `xero_write_succeeded_at` was present, the statement line's active-candidate pointer remained null and there were zero local `xero_objects` rows;
- the retry queried BankTransactions by the exact Reference marker, required a single live result, and verified marker, SPEND type, bank account, £1.37 total and 23 July date before reattachment;
- one database transaction inserted the GUID mapping, changed the candidate to `active/committed`, changed the line to `prepared`, appended its audit event and enqueued observation;
- a third identical request returned the same committed candidate without contacting Xero for another create;
- the bill repeated the same boundary through the `Invoices` exact-Reference lookup and ACCPAY/total/date fingerprint;
- the transfer repeated it through `BankTransfers`, verified from/to accounts, amount and date, then atomically stored all three GUIDs and activated both statement lines;
- Workbench does not create the eventual bill Payment, so there is no Payment write-orphan boundary; Payment discovery and reversal remain covered by the separate observation lifecycle proof;
- the temporary failure-injection secret was removed after the matrix. The guarded hook also required an owner and the exact `Demo Company (UK)` tenant, and unauthorised test headers are rejected before reservation or Xero access.

This closes the orphan/duplicate risk for the currently deployed BankTransaction, Invoice/bill and BankTransfer preparation path. Native Xero idempotency remains short-window protection; exact marker lookup is the durable recovery mechanism.

## Deployed vertical-slice check — 23 July 2026

The Supabase-backed application was also exercised with the supplied July 2026 Starling statement against BORINGBITS LIMITED and the same UK demo tenant:

- all 24 Starling rows were normalized into GBP statement lines;
- replaying the same file created no duplicate rows and reported that there were no new lines;
- the local CSV bank account was explicitly mapped to Xero's `Business Bank Account · 090`;
- live contacts and account codes were fetched from Xero for the candidate form;
- the 16 July `Xero` direct debit for £74.10 created an `AUTHORISED` spend BankTransaction using account `463 · IT Software and Consumables`;
- Workbench stored the returned object and correlation marker, then kept the line in `prepared` after a fresh Xero observation reported it unreconciled;
- the same 24-line statement was imported manually into Xero's mapped bank account with zero duplicates;
- Xero suggested the exact Workbench-created BankTransaction for the £74.10 line, including marker `WB-3FA1128D17814F08BEF1-A1`;
- after accepting that match in Xero, Workbench fetched one updated record and moved only that line from `prepared` to `reconciled`.
- Remove & Redo on that reconciled row deleted the spend BankTransaction while preserving the statement line in Xero;
- the first deployed reversal check exposed that the manual refresh selected only active candidate sets and therefore never polled settled candidates;
- after fixing the selector to poll both active and settled candidates for the selected bank account, Workbench observed `DELETED`, invalidated the old candidate, moved the line to `needs_you`, cleared its active-candidate pointer and displayed the review reason;
- the invalidated attempt remained audit history and the UI required a new candidate rather than offering the deleted GUID for reuse.
- recreating the same line as a bill exposed Xero's requirement that an authorised invoice payload include a due date; the production adapter now sends both `Date` and `DueDate` (defaulting the latter to the statement date);
- the corrected request created one `AUTHORISED` £74.10 bill dated and due 16 July 2026, and Workbench moved the line to `prepared` without claiming reconciliation;
- accepting Xero's suggested bill match created an `AUTHORISED`, reconciled Payment and changed the parent bill to `PAID`;
- this live response exposed an adapter defect: Payment identifies its bank account as `Account.AccountID`, not `BankAccount.AccountID`; after correcting that field, Workbench verified the exact parent bill, bank account, amount and posting date and moved the line from `prepared` to `reconciled`;
- Remove & Redo changed the same Payment to `DELETED`/unreconciled and returned the parent bill to `AUTHORISED`;
- Workbench polled the settled candidate, retained its bill and Payment GUID audit records, marked the Payment deleted, and moved the same line from `reconciled` back to `prepared` with no replacement attempt.
- a second Workbench CSV account was mapped to Xero's `Business Savings Account · 091`, then the existing £67.89 source/destination statement pair was imported into the corresponding Workbench accounts;
- creating the deployed BankTransfer exposed that the first adapter version stored only the BankTransfer GUID and trusted browser-supplied account IDs plus database result ordering for source/destination roles;
- the corrected server derives direction from signed amounts, requires equal/opposite amounts, the same posting date and different mapped accounts, ignores browser-supplied Xero account IDs, and persists the BankTransfer plus both returned BankTransaction GUIDs;
- reconciling only the current-account side moved only the source line to `reconciled`, set only `FromIsReconciled`, and kept the shared candidate `active`;
- reconciling the savings side moved both lines to `reconciled`, set all three stored objects reconciled, and changed the shared candidate to `settled`;
- Remove & Redo on the source row changed the entire BankTransfer to `DELETED`; one settled-candidate observation atomically invalidated both memberships, cleared both active pointers, moved both lines to `needs_you`, and retained all three GUID records as deleted audit evidence.

This completes deployed forward and reverse proofs for BankTransaction, bill/Payment and two-sided BankTransfer candidates across CSV ingestion, Xero candidate creation, partial and full manual Xero reconciliation, authoritative API observation and reversal state transitions. Sales invoices were not repeated through the deployed UI because they use the same now-proven invoice/Payment object class as bills; they remain covered by the capability harness and automated workflow tests.

## Reproduction

See `experiments/xero/README.md`. The key commands are `baseline`, `prepare` and `observe`; manual Xero reconciliation is intentionally outside the harness because the public API does not offer it. Each `observe` run writes a timestamped raw capture for audit.
