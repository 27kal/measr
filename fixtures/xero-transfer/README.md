# Deployed transfer lifecycle fixture

These two one-line statements represent the opposite sides of one GBP transfer in Xero Demo Company (UK):

- `current-090.csv` — £67.89 leaving Business Bank Account (code 090)
- `savings-091.csv` — £67.89 arriving in Business Savings Account (code 091)

Both Xero statement lines were imported during the capability experiment on 21 July 2026. The earlier BankTransfer was removed with Remove & Redo, which preserved the statement lines for the deployed Workbench lifecycle check. Do not import these files into Xero again unless those statement lines have been deleted manually.

Import each file into the correspondingly mapped Workbench CSV account. Create one transfer candidate by pairing the two lines; Workbench must store one shared candidate set and evaluate the two reconciliation flags independently.
