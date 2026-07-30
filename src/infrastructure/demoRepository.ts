import type { AcceptAgentMatchRequest, AnalyseDocumentRequest, ContinueAgentRequest, WorkbenchRepository, WorkbenchSnapshot, PrepareRequest, UploadDocumentRequest, XeroPreflightResponse } from '../application/repository';
import { importStatementCsv } from '../domain/csv';
import { applyXeroObservation, prepareCandidate } from '../domain/workflow';
import type { AgentRecommendation, AgentThread, Company, CompanyChat, CompanyChatThread, CompaniesHouseResult, LineDocument, StatementImport, XeroAttachmentInfo, XeroCandidateOptions, XeroObservation } from '../domain/types';
import { demoCompanies, demoWorkflow } from '../data/seed';

const STORAGE_KEY = 'workbench-demo-v2';

const searchResults: CompaniesHouseResult[] = [
  { number: '09472813', legalName: 'Northstar Coffee Roasters Ltd', registeredOffice: '14 Bermondsey Street, London, SE1 3XF' },
  { number: '15180426', legalName: 'Fig Tree Studio Ltd', registeredOffice: '82 Great Eastern Street, London, EC2A 3JF' },
  { number: '12071684', legalName: 'Northstar Design Services Ltd', registeredOffice: '31 Dale Street, Manchester, M1 1EY' }
];

function fresh(): WorkbenchSnapshot {
  return structuredClone({ companies: demoCompanies, workflow: demoWorkflow, documents: [], analysisBatches: [], xeroObservations: [], statementImports: [], companyChats: [] });
}

export class DemoRepository implements WorkbenchRepository {
  private snapshot: WorkbenchSnapshot = fresh();
  private agentThreads = new Map<string, AgentThread>();
  private companyChatThreads = new Map<string, CompanyChatThread>();

  async load(): Promise<WorkbenchSnapshot> {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) this.agentThreads.clear();
    this.snapshot = stored ? JSON.parse(stored) as WorkbenchSnapshot : fresh();
    this.snapshot.documents ??= [];
    this.snapshot.analysisBatches ??= [];
    this.snapshot.xeroObservations ??= [];
    this.snapshot.statementImports ??= [];
    this.snapshot.companyChats ??= [];
    for (const document of this.snapshot.documents) document.updatedAt ??= document.createdAt;
    return structuredClone(this.snapshot);
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
  }

  async searchCompaniesHouse(query: string): Promise<CompaniesHouseResult[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return [];
    return searchResults.filter(result => result.legalName.toLowerCase().includes(normalized) || result.number.includes(normalized));
  }

  async createCompany(result: CompaniesHouseResult): Promise<Company> {
    const company: Company = {
      id: `company-${crypto.randomUUID()}`,
      legalName: result.legalName,
      companiesHouseNumber: result.number,
      registeredOffice: result.registeredOffice,
      memberRole: 'owner',
      xeroTenantName: null,
      setup: { xeroConnected: false, bankSourceConnected: false, baseCurrency: 'GBP', vatRegistered: null, vatScheme: null },
      lastOpenedBankAccountId: null,
      bankAccounts: []
    };
    this.snapshot.companies.push(company);
    this.save();
    return structuredClone(company);
  }

  async deleteCompany(companyId: string, confirmation: string): Promise<void> {
    const company = this.snapshot.companies.find(item => item.id === companyId);
    if (!company) throw new Error('Company not found');
    if (company.memberRole !== 'owner') throw new Error('Only a company owner can delete this company');
    if (confirmation.toLocaleLowerCase('en-GB') !== company.legalName.toLocaleLowerCase('en-GB')) throw new Error('Company name confirmation does not match');
    this.snapshot.companies = this.snapshot.companies.filter(item => item.id !== companyId);
    this.snapshot.workflow.lines = this.snapshot.workflow.lines.filter(line => line.companyId !== companyId);
    this.snapshot.workflow.candidateSets = this.snapshot.workflow.candidateSets.filter(set => set.companyId !== companyId);
    this.snapshot.companyChats = this.snapshot.companyChats.filter(chat => chat.companyId !== companyId);
    this.save();
  }

  async updateCompany(company: Company): Promise<void> {
    this.snapshot.companies = this.snapshot.companies.map(current => current.id === company.id ? structuredClone(company) : current);
    this.save();
  }

  async importLines(companyId: string, bankAccountId: string, csv: string): Promise<{ imported: number; errors: string[] }> {
    const existing = new Set(this.snapshot.workflow.lines.map(line => line.dedupeKey));
    const result = importStatementCsv(csv, { companyId, bankAccountId, existingDedupeKeys: existing });
    this.snapshot.workflow.lines.push(...result.lines);
    const company = this.snapshot.companies.find(item => item.id === companyId);
    if (company) company.setup.bankSourceConnected = company.bankAccounts.length > 0;
    this.save();
    return { imported: result.lines.length, errors: result.errors.map(error => `Row ${error.row}: ${error.message}`) };
  }

  async uploadStatement(companyId: string, bankAccountId: string, file: File): Promise<StatementImport> {
    if (!['text/csv', 'application/csv'].includes(file.type) && !file.name.toLowerCase().endsWith('.csv')) throw new Error('The local demo can extract CSV statements; connected Workbench also accepts PDF and spreadsheets.');
    const result = await this.importLines(companyId, bankAccountId, await file.text());
    if (result.errors.length) throw new Error(result.errors.join(' '));
    const statementImport: StatementImport = {
      id: `import-${crypto.randomUUID()}`, companyId, bankAccountId, filename: file.name, mimeType: file.type || 'text/csv', byteSize: file.size,
      status: 'complete', institution: 'Demo bank', accountName: '', accountIdentifier: '', periodStart: null, periodEnd: null,
      transactionCount: result.imported, importedCount: result.imported, duplicateCount: 0,
      validation: { valid: true, proofLevel: 'structural', errors: [], warnings: [], checks: [], transactionCount: result.imported, netMovementMinor: 0 },
      error: null, createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
    };
    this.snapshot.statementImports.unshift(statementImport);
    this.save();
    return structuredClone(statementImport);
  }

  async confirmStatementImport(_companyId: string, importId: string): Promise<{ status: 'complete'; imported: number; duplicates: number }> {
    const statementImport = this.snapshot.statementImports.find(item => item.id === importId);
    if (!statementImport) throw new Error('Statement import not found');
    return { status: 'complete', imported: statementImport.importedCount, duplicates: statementImport.duplicateCount };
  }

  async enqueueAnalysis(_companyId: string, _bankAccountId?: string): Promise<{ batchId: string; queued: number }> {
    return { batchId: `demo-${crypto.randomUUID()}`, queued: 0 };
  }

  async enqueueXeroObservation(_companyId: string): Promise<{ jobId: string; scheduled: boolean }> {
    return { jobId: `demo-${crypto.randomUUID()}`, scheduled: true };
  }

  async getXeroCandidateOptions(): Promise<XeroCandidateOptions> {
    return {
      bankAccounts: [{ id: 'demo-bank', name: 'Business current', code: '090' }],
      contacts: [{ id: 'demo-contact', name: 'Demo contact' }],
      accounts: [{ code: '429', name: 'General Expenses', class: 'EXPENSE', taxType: 'INPUT2' }]
    };
  }

  async getXeroAttachments(): Promise<XeroAttachmentInfo[]> {
    return [];
  }

  async prepare(request: PrepareRequest): Promise<void> {
    const line = this.snapshot.workflow.lines.find(item => item.id === request.lineId);
    if (!line) throw new Error('Statement line not found');
    const attempt = this.snapshot.workflow.candidateSets.filter(set => set.lines.some(item => item.statementLineId === line.id)).length + 1;
    const setId = `candidate-${crypto.randomUUID()}`;
    const members = request.kind === 'transfer'
      ? [
          { statementLineId: line.id, role: 'transfer_source' as const, requiredForSettlement: true, expectedBankAccountId: line.bankAccountId, expectedAmountMinor: line.amountMinor },
          (() => {
            const paired = this.snapshot.workflow.lines.find(item => item.id === request.pairedTransferLineId);
            if (!paired) throw new Error('Choose the other bank statement line for this transfer');
            return { statementLineId: paired.id, role: 'transfer_destination' as const, requiredForSettlement: true, expectedBankAccountId: paired.bankAccountId, expectedAmountMinor: paired.amountMinor };
          })()
        ]
      : [{ statementLineId: line.id, role: 'primary' as const, requiredForSettlement: true, expectedBankAccountId: line.bankAccountId, expectedAmountMinor: line.amountMinor }];
    this.snapshot.workflow = prepareCandidate(this.snapshot.workflow, {
      id: setId, companyId: request.companyId, kind: request.kind, attemptNumber: attempt,
      correlationToken: `WB-${line.id.toUpperCase()}-A${attempt}`, xeroObjectId: `demo-${crypto.randomUUID()}`, lines: members,
      transferTransactionIds: request.kind === 'transfer' ? { source: `demo-${crypto.randomUUID()}`, destination: `demo-${crypto.randomUUID()}` } : undefined
    });
    this.save();
  }

  async observe(candidateSetId: string, observation: XeroObservation): Promise<void> {
    this.snapshot.workflow = applyXeroObservation(this.snapshot.workflow, candidateSetId, observation);
    this.save();
  }

  async startXeroConnection(): Promise<string> {
    throw new Error('The local demo does not use OAuth');
  }

  async preflightXeroReconciliation(_companyId: string, lineIds: string[]): Promise<XeroPreflightResponse> {
    return { results: lineIds.map(lineId => ({ lineId, outcome: 'unmatched', message: 'The local demo has no Xero ledger.' })), reconciledLineIds: [], ambiguousLineIds: [], unmatchedLineIds: [...lineIds] };
  }

  async bootstrapAgent(): Promise<AgentThread> {
    return { schemaVersion: 1, runId: crypto.randomUUID(), kind: 'bootstrap', model: 'demo', createdAt: new Date().toISOString(), input: {}, finalOutput: { summary: 'Demo memory initialized.', entriesCreatedOrUpdated: [], caveats: ['Local demo does not call Xero or a model.'] }, history: [], responseIds: [] };
  }

  async runShadowAgent(_companyId: string, lineId: string): Promise<AgentThread> {
    const line = this.snapshot.workflow.lines.find(item => item.id === lineId);
    if (!line) throw new Error('Statement line not found');
    if (line.activeCandidateSetId || line.status === 'prepared' || line.status === 'reconciled') throw new Error('Prepared and reconciled lines cannot be analysed again');
    const inputLine = structuredClone(line);
    line.status = 'needs_you'; line.statusVersion += 1; line.note = 'Agent analysis needs your judgement.'; this.save();
    const thread: AgentThread = { schemaVersion: 1, runId: crypto.randomUUID(), kind: 'line', model: 'demo', createdAt: new Date().toISOString(), input: { statementLine: inputLine }, finalOutput: { outcome: 'needs_review', proposedOperation: 'human_review', candidateKind: 'bank_transaction', existingXeroEntityType: 'none', existingXeroEntityId: '', existingXeroEntityNumber: '', existingXeroMatchReason: '', contactId: '', contactName: '', accountCode: '', accountName: '', taxType: '', description: line.description, reference: line.reference, reply: 'I analysed this line and need the correct Xero contact and account.', summary: 'Demo-only recommendation; no live model or Xero history was used.', evidence: [{ source: 'statement_line', title: 'Statement line', detail: line.description, url: '' }], questions: ['Which Xero contact and account should be used?'] }, history: [{ role: 'user', content: 'Analyse this bank statement line' }], responseIds: [], workflowProjection: { status: 'needs_you', statusVersion: line.statusVersion, note: line.note } };
    thread.timeline = [{ runId: thread.runId, createdAt: thread.createdAt, finalOutput: thread.finalOutput as AgentRecommendation }];
    this.agentThreads.set(lineId, thread);
    return structuredClone(thread);
  }

  async getAgentThread(_companyId: string, lineId?: string): Promise<AgentThread | null> {
    return lineId && this.agentThreads.has(lineId) ? structuredClone(this.agentThreads.get(lineId)!) : null;
  }

  async ensureHandbookPropagation(_companyId: string, _lineId: string, _runId: string): Promise<void> {}

  async continueAgent(request: ContinueAgentRequest): Promise<AgentThread> {
    const previous = this.agentThreads.get(request.lineId);
    const line = this.snapshot.workflow.lines.find(item => item.id === request.lineId);
    if (!previous || !line || previous.runId !== request.runId || line.statusVersion !== request.statusVersion) throw new Error('The agent thread changed; refresh before sending this message');
    line.statusVersion += 1;
    const recommendation = previous.finalOutput as AgentThread['finalOutput'] & { summary: string };
    const thread: AgentThread = { ...structuredClone(previous), runId: crypto.randomUUID(), parentRunId: previous.runId, userMessage: request.message, createdAt: new Date().toISOString(), finalOutput: { ...recommendation, reply: `Demo agent replied to: “${request.message}”` }, history: [...previous.history, { role: 'user', content: request.message }], workflowProjection: { status: 'needs_you', statusVersion: line.statusVersion, note: line.note } };
    thread.timeline = [...(previous.timeline ?? []), { runId: thread.runId, parentRunId: thread.parentRunId, createdAt: thread.createdAt, userMessage: request.message, finalOutput: thread.finalOutput as AgentRecommendation }];
    this.agentThreads.set(request.lineId, thread);
    this.save();
    return structuredClone(thread);
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<{ thread?: AgentThread; document: LineDocument }> {
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(request.file.type)) throw new Error('Upload a PDF, PNG, JPEG or WebP document');
    const thread = await this.continueAgent({ ...request, message: `Uploaded ${request.file.name}` });
    const document: LineDocument = {
      id: `document-${crypto.randomUUID()}`, companyId: request.companyId, statementLineId: request.lineId,
      filename: request.file.name, mimeType: request.file.type, byteSize: request.file.size, sha256: 'demo',
      analysisStatus: 'analysed', analysisError: null, candidateSetId: null, xeroObjectType: null,
      xeroObjectId: null, xeroFilename: null, xeroAttachmentId: null, xeroUploadedAt: null,
      xeroUploadError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    this.snapshot.documents.push(document);
    this.save();
    return { thread, document: structuredClone(document) };
  }

  async retryDocumentAnalysis(request: AnalyseDocumentRequest): Promise<{ thread?: AgentThread; document: LineDocument }> {
    const document = this.snapshot.documents.find(item => item.id === request.documentId && item.statementLineId === request.lineId);
    if (!document) throw new Error('Document not found');
    document.analysisStatus = 'analysed';
    document.analysisError = null;
    document.updatedAt = new Date().toISOString();
    const thread = await this.continueAgent({ ...request, message: `Retried ${document.filename}` });
    this.save();
    return { thread, document: structuredClone(document) };
  }

  async syncDocumentToXero(_companyId: string, documentId: string): Promise<LineDocument> {
    const document = this.snapshot.documents.find(item => item.id === documentId);
    if (!document) throw new Error('Document not found');
    document.xeroUploadedAt = new Date().toISOString();
    document.xeroAttachmentId = `demo-attachment-${crypto.randomUUID()}`;
    document.xeroUploadError = null;
    this.save();
    return structuredClone(document);
  }

  async acceptAgentMatch(_request: AcceptAgentMatchRequest): Promise<{ attachments: { uploaded: string[]; errors: Array<{ documentId: string; message: string }> } }> {
    throw new Error('Existing Xero matching is only available in the connected Workbench');
  }

  async acceptAgentCreate(request: AcceptAgentMatchRequest): Promise<{ attachments: { uploaded: string[]; errors: Array<{ documentId: string; message: string }> } }> {
    const thread = this.agentThreads.get(request.lineId);
    const recommendation = thread?.finalOutput as { proposedOperation?: string; candidateKind?: PrepareRequest['kind'] } | undefined;
    if (!thread || thread.runId !== request.runId || recommendation?.proposedOperation !== 'create_new' || !recommendation.candidateKind) throw new Error('This demo recommendation is not executable');
    await this.prepare({ companyId: request.companyId, lineId: request.lineId, kind: recommendation.candidateKind });
    const documents = this.snapshot.documents.filter(document => document.statementLineId === request.lineId);
    for (const document of documents) await this.syncDocumentToXero(request.companyId, document.id);
    return { attachments: { uploaded: documents.map(document => document.id), errors: [] } };
  }

  async createCompanyChat(companyId: string, firstMessage: string): Promise<CompanyChat> {
    const message = firstMessage.trim();
    if (!message) throw new Error('Enter a message to start a chat');
    const now = new Date().toISOString();
    const chat: CompanyChat = {
      id: `chat-${crypto.randomUUID()}`, companyId, title: message.replace(/\s+/g, ' ').slice(0, 72),
      createdBy: 'demo-user', latestRunId: null, running: false, lastError: null, createdAt: now, updatedAt: now
    };
    this.snapshot.companyChats.unshift(chat);
    this.save();
    return structuredClone(chat);
  }

  async getCompanyChatThread(_companyId: string, chatId: string): Promise<CompanyChatThread | null> {
    return structuredClone(this.companyChatThreads.get(chatId) ?? null);
  }

  async resetDemo(): Promise<void> {
    this.snapshot = fresh();
    this.agentThreads.clear();
    this.companyChatThreads.clear();
    localStorage.removeItem(STORAGE_KEY);
  }
}
