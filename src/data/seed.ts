import type { CandidateSet, Company, StatementLine, WorkflowState } from '../domain/types';

export const demoCompanies: Company[] = [
  {
    id: 'company-northstar',
    legalName: 'Northstar Coffee Roasters Ltd',
    companiesHouseNumber: '09472813',
    registeredOffice: '14 Bermondsey Street, London, SE1 3XF',
    memberRole: 'owner',
    xeroTenantName: 'Demo Company (UK)',
    setup: {
      xeroConnected: true,
      bankSourceConnected: true,
      baseCurrency: 'GBP',
      vatRegistered: true,
      vatScheme: 'standard'
    },
    lastOpenedBankAccountId: 'bank-main',
    bankAccounts: [
      { id: 'bank-main', companyId: 'company-northstar', name: 'Business current · 5421', currency: 'GBP', source: 'open_banking', xeroAccountId: 'demo-bank-main' },
      { id: 'bank-savings', companyId: 'company-northstar', name: 'Business reserve · 1048', currency: 'GBP', source: 'csv', xeroAccountId: 'demo-bank-savings' }
    ]
  },
  {
    id: 'company-fig-tree',
    legalName: 'Fig Tree Studio Ltd',
    companiesHouseNumber: '15180426',
    registeredOffice: '82 Great Eastern Street, London, EC2A 3JF',
    memberRole: 'owner',
    xeroTenantName: null,
    setup: {
      xeroConnected: false,
      bankSourceConnected: false,
      baseCurrency: 'GBP',
      vatRegistered: null,
      vatScheme: null
    },
    lastOpenedBankAccountId: null,
    bankAccounts: []
  }
];

const lines: StatementLine[] = [
  {
    id: 'line-fastpay', companyId: 'company-northstar', bankAccountId: 'bank-main', postedAt: '2026-07-18', amountMinor: -122391,
    currency: 'GBP', payee: 'FastPay', description: 'Card settlement FP101897', reference: 'FP101897', status: 'needs_you', statusVersion: 2,
    activeCandidateSetId: null, note: 'No confident account match. Choose what this payment was for.', dedupeKey: 'demo-fastpay'
  },
  {
    id: 'line-acme', companyId: 'company-northstar', bankAccountId: 'bank-main', postedAt: '2026-07-17', amountMinor: -48600,
    currency: 'GBP', payee: 'Acme Packaging', description: 'Invoice AP-4471', reference: 'AP-4471', status: 'needs_you', statusVersion: 1,
    activeCandidateSetId: null, note: 'Ask the client for the supplier invoice, then upload it here.', dedupeKey: 'demo-acme'
  },
  {
    id: 'line-tfl', companyId: 'company-northstar', bankAccountId: 'bank-main', postedAt: '2026-07-16', amountMinor: -1840,
    currency: 'GBP', payee: 'Transport for London', description: 'Contactless travel', reference: '', status: 'prepared', statusVersion: 3,
    activeCandidateSetId: 'candidate-tfl', note: 'Spend money transaction created in Xero. Open Xero to reconcile it.', dedupeKey: 'demo-tfl'
  },
  {
    id: 'line-square', companyId: 'company-northstar', bankAccountId: 'bank-main', postedAt: '2026-07-15', amountMinor: 58342,
    currency: 'GBP', payee: 'Square', description: 'Daily card takings', reference: 'SQ-1507', status: 'reconciled', statusVersion: 4,
    activeCandidateSetId: 'candidate-square', note: 'Xero reports the linked receive money transaction reconciled.', dedupeKey: 'demo-square'
  },
  {
    id: 'line-rent', companyId: 'company-northstar', bankAccountId: 'bank-main', postedAt: '2026-07-14', amountMinor: -285000,
    currency: 'GBP', payee: 'Archway Properties', description: 'July premises rent', reference: 'RENT-JUL', status: 'new', statusVersion: 0,
    activeCandidateSetId: null, note: 'Imported and waiting for analysis.', dedupeKey: 'demo-rent'
  },
  {
    id: 'line-transfer-out', companyId: 'company-northstar', bankAccountId: 'bank-main', postedAt: '2026-07-13', amountMinor: -100000,
    currency: 'GBP', payee: 'Internal transfer', description: 'Transfer to reserve', reference: 'TR-1307', status: 'needs_you', statusVersion: 1,
    activeCandidateSetId: null, note: 'Possible transfer to Business reserve · 1048.', dedupeKey: 'demo-transfer-out'
  },
  {
    id: 'line-transfer-in', companyId: 'company-northstar', bankAccountId: 'bank-savings', postedAt: '2026-07-13', amountMinor: 100000,
    currency: 'GBP', payee: 'Internal transfer', description: 'Transfer from current', reference: 'TR-1307', status: 'new', statusVersion: 0,
    activeCandidateSetId: null, note: 'Imported and waiting for analysis.', dedupeKey: 'demo-transfer-in'
  }
];

const candidates: CandidateSet[] = [
  {
    id: 'candidate-tfl', companyId: 'company-northstar', attemptNumber: 1, kind: 'bank_transaction', status: 'active', invalidationReason: null,
    lines: [{ statementLineId: 'line-tfl', role: 'primary', requiredForSettlement: true, expectedBankAccountId: 'bank-main', expectedAmountMinor: -1840, verificationStatus: 'prepared' }],
    xeroObjects: [{ id: 'candidate-tfl:primary', objectType: 'bank_transaction', objectRole: 'primary', xeroObjectId: 'demo-xero-tfl', xeroStatus: 'AUTHORISED', isReconciled: false, correlationToken: 'WB-LINE-TFL-A1', correlationChannels: ['url', 'reference', 'history_note'], deletedAt: null }]
  },
  {
    id: 'candidate-square', companyId: 'company-northstar', attemptNumber: 1, kind: 'bank_transaction', status: 'settled', invalidationReason: null,
    lines: [{ statementLineId: 'line-square', role: 'primary', requiredForSettlement: true, expectedBankAccountId: 'bank-main', expectedAmountMinor: 58342, verificationStatus: 'reconciled' }],
    xeroObjects: [{ id: 'candidate-square:primary', objectType: 'bank_transaction', objectRole: 'primary', xeroObjectId: 'demo-xero-square', xeroStatus: 'AUTHORISED', isReconciled: true, correlationToken: 'WB-LINE-SQUARE-A1', correlationChannels: ['url', 'reference', 'history_note'], deletedAt: null }]
  }
];

export const demoWorkflow: WorkflowState = { lines, candidateSets: candidates };
