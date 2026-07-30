import type { AgentAnalysisBatchProgress, AgentThread, CandidateKind, Company, CompanyChat, CompanyChatThread, CompaniesHouseResult, LineDocument, StatementImport, WorkflowState, XeroAttachmentInfo, XeroCandidateOptions, XeroObservation, XeroObservationProgress } from '../domain/types';

export interface PrepareRequest {
  companyId: string;
  lineId: string;
  kind: CandidateKind;
  pairedTransferLineId?: string;
  candidate?: Record<string, string>;
}

export interface AcceptAgentMatchRequest {
  companyId: string;
  lineId: string;
  runId: string;
  statusVersion: number;
}

export interface ContinueAgentRequest extends AcceptAgentMatchRequest {
  message: string;
}

export interface UploadDocumentRequest extends AcceptAgentMatchRequest {
  file: File;
}

export interface AnalyseDocumentRequest extends AcceptAgentMatchRequest {
  documentId: string;
}

export interface AcceptAgentCreateResult {
  attachments?: { uploaded: string[]; errors: Array<{ documentId: string; message: string }> };
}

export interface XeroPreflightResult {
  lineId: string;
  outcome: 'reconciled' | 'ambiguous' | 'unmatched';
  message: string;
  candidateSetId?: string;
  candidates?: Array<{ key: string; kind: string; date: string; amountMinor: number; contactName: string; reference: string }>;
}

export interface XeroPreflightResponse {
  results: XeroPreflightResult[];
  reconciledLineIds: string[];
  ambiguousLineIds: string[];
  unmatchedLineIds: string[];
}

export interface StatementImportDeletionResult {
  filename: string;
  deletedLines: number;
  reopenedLines: number;
}

export interface WorkbenchSnapshot {
  companies: Company[];
  workflow: WorkflowState;
  documents: LineDocument[];
  analysisBatches: AgentAnalysisBatchProgress[];
  xeroObservations: XeroObservationProgress[];
  statementImports: StatementImport[];
  companyChats: CompanyChat[];
}

export interface WorkbenchRepository {
  load(): Promise<WorkbenchSnapshot>;
  searchCompaniesHouse(query: string): Promise<CompaniesHouseResult[]>;
  createCompany(result: CompaniesHouseResult): Promise<Company>;
  deleteCompany(companyId: string, confirmation: string): Promise<void>;
  updateCompany(company: Company): Promise<void>;
  importLines(companyId: string, bankAccountId: string, csv: string): Promise<{ imported: number; errors: string[] }>;
  uploadStatement(companyId: string, bankAccountId: string, file: File): Promise<StatementImport>;
  confirmStatementImport(companyId: string, importId: string): Promise<{ status: 'complete'; imported: number; duplicates: number }>;
  deleteStatementImport(companyId: string, importId: string): Promise<StatementImportDeletionResult>;
  enqueueAnalysis(companyId: string, bankAccountId?: string): Promise<{ batchId: string; queued: number }>;
  enqueueXeroObservation(companyId: string): Promise<{ jobId: string; scheduled: boolean }>;
  getXeroCandidateOptions(companyId: string): Promise<XeroCandidateOptions>;
  getXeroAttachments(companyId: string, entityType: 'invoice' | 'bank_transaction', entityId: string): Promise<XeroAttachmentInfo[]>;
  prepare(request: PrepareRequest): Promise<void>;
  observe(candidateSetId: string, observation: XeroObservation): Promise<void>;
  startXeroConnection(companyId: string): Promise<string>;
  preflightXeroReconciliation(companyId: string, lineIds: string[]): Promise<XeroPreflightResponse>;
  bootstrapAgent(companyId: string): Promise<AgentThread>;
  runShadowAgent(companyId: string, lineId: string): Promise<AgentThread>;
  getAgentThread(companyId: string, lineId?: string): Promise<AgentThread | null>;
  ensureHandbookPropagation(companyId: string, lineId: string, runId: string): Promise<void>;
  continueAgent(request: ContinueAgentRequest): Promise<AgentThread>;
  uploadDocument(request: UploadDocumentRequest): Promise<{ thread?: AgentThread; document: LineDocument }>;
  retryDocumentAnalysis(request: AnalyseDocumentRequest): Promise<{ thread?: AgentThread; document: LineDocument }>;
  syncDocumentToXero(companyId: string, documentId: string): Promise<LineDocument>;
  acceptAgentMatch(request: AcceptAgentMatchRequest): Promise<AcceptAgentCreateResult>;
  acceptAgentCreate(request: AcceptAgentMatchRequest): Promise<AcceptAgentCreateResult>;
  createCompanyChat(companyId: string, firstMessage: string): Promise<CompanyChat>;
  getCompanyChatThread(companyId: string, chatId: string): Promise<CompanyChatThread | null>;
  resetDemo(): Promise<void>;
}
