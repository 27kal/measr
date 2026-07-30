export type StatementLineStatus =
  | 'new'
  | 'processing'
  | 'needs_you'
  | 'waiting_doc'
  | 'prepared'
  | 'reconciled';

export type CandidateKind = 'bank_transaction' | 'bill' | 'invoice' | 'transfer';
export type CandidateSetStatus = 'building' | 'active' | 'settled' | 'invalidated';
export type CandidateLineRole = 'primary' | 'transfer_source' | 'transfer_destination';

export interface CompanySetup {
  xeroConnected: boolean;
  bankSourceConnected: boolean;
  baseCurrency: 'GBP' | null;
  vatRegistered: boolean | null;
  vatScheme: 'standard' | 'cash' | 'flat_rate' | 'not_applicable' | null;
}

export interface Company {
  id: string;
  legalName: string;
  companiesHouseNumber: string;
  registeredOffice: string;
  memberRole: 'owner' | 'bookkeeper' | 'viewer';
  xeroTenantName: string | null;
  xeroScopes?: string[];
  setup: CompanySetup;
  lastOpenedBankAccountId: string | null;
  bankAccounts: BankAccount[];
}

export interface BankAccount {
  id: string;
  companyId: string;
  name: string;
  currency: 'GBP';
  source: 'open_banking' | 'csv';
  xeroAccountId: string | null;
}

export type StatementImportStatus = 'queued' | 'processing' | 'retryable' | 'awaiting_confirmation' | 'complete' | 'failed';

export interface StatementImportValidation {
  valid: boolean;
  proofLevel: 'balanced' | 'cross_checked' | 'structural';
  errors: string[];
  warnings: string[];
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  transactionCount: number;
  netMovementMinor: number;
}

export interface StatementImport {
  id: string;
  companyId: string;
  bankAccountId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  status: StatementImportStatus;
  institution: string;
  accountName: string;
  accountIdentifier: string;
  periodStart: string | null;
  periodEnd: string | null;
  transactionCount: number;
  importedCount: number;
  duplicateCount: number;
  validation: StatementImportValidation | null;
  error: string | null;
  ingestionRunId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface XeroCandidateOptions {
  bankAccounts: Array<{ id: string; name: string; code: string }>;
  contacts: Array<{ id: string; name: string }>;
  accounts: Array<{ code: string; name: string; class: string; taxType: string }>;
}

export interface XeroAttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  contentLength: number | null;
}

export interface StatementLine {
  id: string;
  companyId: string;
  bankAccountId: string;
  /** The ingestion run that created this line; absent for legacy demo fixtures. */
  ingestionRunId?: string | null;
  postedAt: string;
  amountMinor: number;
  currency: 'GBP';
  payee: string;
  description: string;
  reference: string;
  status: StatementLineStatus;
  statusVersion: number;
  activeCandidateSetId: string | null;
  note: string;
  dedupeKey: string;
}

export interface CandidateSetLine {
  statementLineId: string;
  role: CandidateLineRole;
  requiredForSettlement: boolean;
  expectedBankAccountId: string;
  expectedAmountMinor: number;
  verificationStatus: 'prepared' | 'reconciled' | 'invalidated';
}

export interface XeroObject {
  id: string;
  objectType: 'bank_transaction' | 'bank_transfer' | 'invoice' | 'payment';
  objectRole: 'primary' | 'source_transaction' | 'destination_transaction' | 'parent_document' | 'payment';
  xeroObjectId: string;
  xeroStatus: string;
  isReconciled: boolean | null;
  correlationToken: string;
  correlationChannels: Array<'url' | 'reference' | 'history_note' | 'local_only'>;
  deletedAt: string | null;
}

export interface CandidateSet {
  id: string;
  companyId: string;
  attemptNumber: number;
  kind: CandidateKind;
  status: CandidateSetStatus;
  lines: CandidateSetLine[];
  xeroObjects: XeroObject[];
  invalidationReason: string | null;
}

export interface WorkflowState {
  lines: StatementLine[];
  candidateSets: CandidateSet[];
}

export interface AgentAnalysisBatchProgress {
  id: string;
  companyId: string;
  bankAccountId: string | null;
  source: 'csv_import' | 'bank_feed' | 'manual_backfill';
  status: 'queued' | 'snapshotting' | 'running' | 'complete' | 'partial' | 'failed';
  total: number;
  queued: number;
  analysing: number;
  retrying: number;
  succeeded: number;
  skipped: number;
  failed: number;
  activeLineIds: string[];
  createdAt: string;
}

export interface XeroObservationProgress {
  companyId: string;
  status: 'idle' | 'syncing' | 'retrying' | 'error';
  lastSucceededAt: string | null;
  nextEligibleAt: string | null;
  lastError: string | null;
  candidateCount: number;
  unlinkedLineCount: number;
  changedLineCount: number;
}

export interface LineDocument {
  id: string;
  companyId: string;
  statementLineId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  analysisStatus: 'pending' | 'processing' | 'analysed' | 'failed';
  analysisError: string | null;
  candidateSetId: string | null;
  xeroObjectType: 'bank_transaction' | 'invoice' | 'bank_transfer' | null;
  xeroObjectId: string | null;
  xeroFilename: string | null;
  xeroAttachmentId: string | null;
  xeroUploadedAt: string | null;
  xeroUploadError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface XeroObservation {
  parentStatus?: string;
  objectStatus?: string;
  isReconciled?: boolean;
  fingerprintMatches?: boolean;
  fromIsReconciled?: boolean;
  toIsReconciled?: boolean;
  fromFingerprintMatches?: boolean;
  toFingerprintMatches?: boolean;
  payment?: {
    xeroObjectId: string;
    status: string;
    isReconciled: boolean;
    amountMinor: number;
    bankAccountId: string;
  };
}

export interface ReadinessCheck {
  id: 'xero' | 'bank' | 'currency' | 'vat_registration' | 'vat_scheme';
  label: string;
  complete: boolean;
  blocking: boolean;
}

export interface CompaniesHouseResult {
  number: string;
  legalName: string;
  registeredOffice: string;
}

export interface AgentRecommendation {
  outcome: 'recommend_candidate' | 'needs_information' | 'needs_review';
  proposedOperation: 'create_new' | 'match_existing' | 'request_information' | 'human_review';
  candidateKind: CandidateKind | 'none';
  existingXeroEntityType: 'bank_transaction' | 'invoice' | 'transfer' | 'none';
  existingXeroEntityId: string;
  existingXeroEntityNumber: string;
  existingXeroMatchReason: string;
  contactId: string;
  contactName: string;
  accountCode: string;
  accountName: string;
  taxType: string;
  description: string;
  reference: string;
  documentDate?: string;
  dueDate?: string;
  reply?: string;
  summary: string;
  evidence: Array<{ source: 'statement_line' | 'document' | 'xero_history' | 'handbook' | 'hmrc'; title: string; detail: string; url: string }>;
  questions: string[];
}

export interface AgentTimelineRun {
  runId: string;
  parentRunId?: string;
  createdAt: string;
  userMessage?: string;
  document?: { id: string; filename: string; mimeType: string; byteSize: number; sha256: string };
  reconsideration?: AgentReconsideration;
  batch?: AgentBatchLineage;
  finalOutput: AgentRecommendation;
}

export interface AgentReconsideration {
  sourceRunId: string;
  sourceLineId: string;
  handbookEntries: Array<{ name: string; content: string }>;
  reason: string;
}

export interface AgentBatchLineage {
  batchId: string;
  jobId: string;
  snapshotCreatedAt: string;
}

export interface AgentThread {
  schemaVersion: number;
  runId: string;
  kind: 'bootstrap' | 'line';
  model: string;
  createdAt: string;
  input: unknown;
  finalOutput: AgentRecommendation | { summary: string; entriesCreatedOrUpdated: string[]; caveats: string[] };
  history: unknown[];
  responseIds: string[];
  parentRunId?: string;
  userMessage?: string;
  document?: { id: string; filename: string; mimeType: string; byteSize: number; sha256: string };
  reconsideration?: AgentReconsideration;
  batch?: AgentBatchLineage;
  xeroDocuments?: Array<{
    source: 'xero';
    attachmentId: string;
    entityType: 'invoice' | 'bank_transaction';
    entityId: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
  }>;
  workflowProjection?: { status: StatementLineStatus; statusVersion: number; note: string };
  timeline?: AgentTimelineRun[];
}

export interface CompanyChat {
  id: string;
  companyId: string;
  title: string;
  createdBy: string;
  latestRunId: string | null;
  running: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface CompanyChatThread {
  schemaVersion: number;
  kind: 'company_chat';
  runId: string;
  parentRunId?: string;
  model: string;
  createdAt: string;
  userMessage: string;
  finalOutput: string;
  history: unknown[];
  responseIds: string[];
  messages: CompanyChatMessage[];
}
