import type { AcceptAgentCreateResult, AcceptAgentMatchRequest, AnalyseDocumentRequest, ContinueAgentRequest, PrepareRequest, StatementImportDeletionResult, UploadDocumentRequest, WorkbenchRepository, WorkbenchSnapshot, XeroPreflightResponse } from '../application/repository';
import { importStatementCsv } from '../domain/csv';
import type { AgentAnalysisBatchProgress, AgentThread, BankAccount, CandidateSet, Company, CompanyChat, CompanyChatThread, CompaniesHouseResult, LineDocument, StatementImport, StatementLine, XeroAttachmentInfo, XeroCandidateOptions, XeroObservation, XeroObservationProgress } from '../domain/types';
import { invokeBackend, invokeBackendForm, supabase } from './supabase';

function client() {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

function mapDocument(row: Record<string, any>): LineDocument {
  return {
    id: row.id, companyId: row.company_id, statementLineId: row.statement_line_id,
    filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), sha256: row.sha256,
    analysisStatus: row.analysis_status, analysisError: row.analysis_error,
    candidateSetId: row.candidate_set_id, xeroObjectType: row.xero_object_type, xeroObjectId: row.xero_object_id,
    xeroFilename: row.xero_filename, xeroAttachmentId: row.xero_attachment_id,
    xeroUploadedAt: row.xero_uploaded_at, xeroUploadError: row.xero_upload_error, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapStatementImport(row: Record<string, any>): StatementImport {
  return {
    id: row.id, companyId: row.company_id ?? row.companyId, bankAccountId: row.bank_account_id ?? row.bankAccountId,
    filename: row.filename, mimeType: row.mime_type ?? row.mimeType, byteSize: Number(row.byte_size ?? row.byteSize),
    status: row.status, institution: row.detected_institution ?? row.institution ?? '', accountName: row.detected_account_name ?? row.accountName ?? '',
    accountIdentifier: row.detected_account_identifier ?? row.accountIdentifier ?? '', periodStart: row.period_start ?? row.periodStart ?? null,
    periodEnd: row.period_end ?? row.periodEnd ?? null, transactionCount: Number(row.transaction_count ?? row.transactionCount ?? 0),
    importedCount: Number(row.imported_count ?? row.importedCount ?? 0), duplicateCount: Number(row.duplicate_count ?? row.duplicateCount ?? 0),
    validation: row.validation ?? null, error: row.last_error ?? row.error ?? null,
    ingestionRunId: row.ingestion_run_id ?? row.ingestionRunId ?? null, createdAt: row.created_at ?? row.createdAt,
    completedAt: row.completed_at ?? row.completedAt ?? null
  };
}

export class SupabaseRepository implements WorkbenchRepository {
  async load(): Promise<WorkbenchSnapshot> {
    const db = client();
    const [companiesResult, accountsResult, linesResult, setsResult, setLinesResult, objectsResult, xeroResult, companyMembershipsResult, documentsResult, batchesResult, jobsResult, observationQueuesResult, observationJobsResult, statementImportsResult, companyChatsResult] = await Promise.all([
      db.from('companies').select('*').order('legal_name'),
      db.from('bank_accounts').select('*').order('created_at'),
      db.from('statement_lines').select('*').order('posted_at', { ascending: false }),
      db.from('candidate_sets').select('*').order('created_at'),
      db.from('candidate_set_lines').select('*'),
      db.from('xero_objects').select('*'),
      db.from('xero_connections').select('company_id, tenant_name, scopes, disconnected_at'),
      db.from('company_memberships').select('company_id, role'),
      db.from('documents').select('*').order('created_at'),
      db.from('agent_analysis_batches').select('*').order('created_at', { ascending: false }).limit(30),
      db.from('agent_analysis_jobs').select('id,batch_id,statement_line_id,state').order('created_at'),
      db.from('xero_observation_org_queue').select('*'),
      db.from('xero_observation_jobs').select('id,company_id,state,candidate_count,unlinked_line_count,changed_line_count,created_at').order('created_at', { ascending: false }).limit(60),
      db.from('statement_imports').select('*').order('created_at', { ascending: false }).limit(60),
      db.from('company_chats').select('*').order('updated_at', { ascending: false }).limit(100)
    ]);
    const error = [companiesResult, accountsResult, linesResult, setsResult, setLinesResult, objectsResult, xeroResult, companyMembershipsResult, documentsResult, batchesResult, jobsResult, observationQueuesResult, observationJobsResult, statementImportsResult, companyChatsResult].find(result => result.error)?.error;
    if (error) throw error;
    const accounts = (accountsResult.data ?? []) as Array<Record<string, unknown>>;
    const activeXeroConnections = (xeroResult.data ?? []).filter(row => !row.disconnected_at);
    const companies: Company[] = (companiesResult.data ?? []).map(row => ({
      id: row.id, legalName: row.legal_name, companiesHouseNumber: row.companies_house_number, registeredOffice: row.registered_office,
      memberRole: (companyMembershipsResult.data ?? []).find(membership => membership.company_id === row.id)?.role ?? 'viewer',
      xeroTenantName: activeXeroConnections.find(connection => connection.company_id === row.id)?.tenant_name ?? null,
      xeroScopes: activeXeroConnections.find(connection => connection.company_id === row.id)?.scopes ?? [],
      lastOpenedBankAccountId: null,
      setup: { xeroConnected: activeXeroConnections.some(connection => connection.company_id === row.id), bankSourceConnected: accounts.some(account => account.company_id === row.id), baseCurrency: row.base_currency, vatRegistered: row.vat_registered, vatScheme: row.vat_scheme },
      bankAccounts: accounts.filter(account => account.company_id === row.id).map(account => ({ id: String(account.id), companyId: String(account.company_id), name: String(account.name), currency: 'GBP', source: account.source as BankAccount['source'], xeroAccountId: account.xero_account_id ? String(account.xero_account_id) : null }))
    }));
    const lines: StatementLine[] = (linesResult.data ?? []).map(row => ({
      id: row.id, companyId: row.company_id, bankAccountId: row.bank_account_id, ingestionRunId: row.ingestion_run_id ?? null, postedAt: row.posted_at, amountMinor: Number(row.amount_minor), currency: 'GBP', payee: row.payee,
      description: row.description, reference: row.reference, status: row.status, statusVersion: row.status_version, activeCandidateSetId: row.active_candidate_set_id, note: row.note, dedupeKey: row.dedupe_key
    }));
    const setLines = setLinesResult.data ?? [];
    const xeroObjects = objectsResult.data ?? [];
    const candidateSets: CandidateSet[] = (setsResult.data ?? []).map(row => ({
      id: row.id, companyId: row.company_id, attemptNumber: row.attempt_number, kind: row.kind, status: row.status, invalidationReason: row.invalidation_reason,
      lines: setLines.filter(member => member.candidate_set_id === row.id).map(member => ({ statementLineId: member.statement_line_id, role: member.role, requiredForSettlement: member.required_for_settlement, expectedBankAccountId: member.expected_bank_account_id, expectedAmountMinor: Number(member.expected_amount_minor), verificationStatus: member.verification_status })),
      xeroObjects: xeroObjects.filter(object => object.candidate_set_id === row.id).map(object => ({ id: object.id, objectType: object.object_type, objectRole: object.object_role, xeroObjectId: object.xero_object_id, xeroStatus: object.xero_status, isReconciled: object.is_reconciled, correlationToken: object.correlation_token, correlationChannels: object.correlation_channels, deletedAt: object.deleted_at }))
    }));
    const jobs = jobsResult.data ?? [];
    const analysisBatches: AgentAnalysisBatchProgress[] = (batchesResult.data ?? []).map(batch => {
      const batchJobs = jobs.filter(job => job.batch_id === batch.id);
      const count = (state: string) => batchJobs.filter(job => job.state === state).length;
      return {
        id: batch.id, companyId: batch.company_id, bankAccountId: batch.bank_account_id, source: batch.source, status: batch.status,
        total: batchJobs.length, queued: count('queued'), analysing: count('leased'), retrying: count('retryable'),
        succeeded: count('succeeded'), skipped: count('skipped'), failed: count('failed'),
        activeLineIds: batchJobs.filter(job => ['queued', 'leased', 'retryable'].includes(job.state)).map(job => job.statement_line_id),
        createdAt: batch.created_at
      };
    });
    const observationJobs = observationJobsResult.data ?? [];
    const xeroObservations: XeroObservationProgress[] = (observationQueuesResult.data ?? []).map(queue => {
      const latest = observationJobs.find(job => job.company_id === queue.company_id);
      const state = latest?.state;
      return {
        companyId: queue.company_id,
        status: state === 'leased' || state === 'queued' ? 'syncing' : state === 'retryable' ? 'retrying' : queue.last_error ? 'error' : 'idle',
        lastSucceededAt: queue.last_succeeded_at,
        nextEligibleAt: queue.next_eligible_at,
        lastError: queue.last_error,
        candidateCount: Number(latest?.candidate_count ?? 0),
        unlinkedLineCount: Number(latest?.unlinked_line_count ?? 0),
        changedLineCount: Number(latest?.changed_line_count ?? 0)
      };
    });
    const companyChats: CompanyChat[] = (companyChatsResult.data ?? []).map(row => ({
      id: row.id, companyId: row.company_id, title: row.title, createdBy: row.created_by,
      latestRunId: row.latest_run_id, running: Boolean(row.running_run_id), lastError: row.last_error,
      createdAt: row.created_at, updatedAt: row.updated_at
    }));
    return { companies, workflow: { lines, candidateSets }, documents: (documentsResult.data ?? []).map(mapDocument), analysisBatches, xeroObservations, statementImports: (statementImportsResult.data ?? []).map(mapStatementImport), companyChats };
  }

  async searchCompaniesHouse(query: string): Promise<CompaniesHouseResult[]> {
    const response = await invokeBackend<{ items: CompaniesHouseResult[] }>('companies-house-search', { query });
    return response.items;
  }

  async createCompany(result: CompaniesHouseResult): Promise<Company> {
    const { data, error } = await client().rpc('create_company_onboarding', { p_legal_name: result.legalName, p_companies_house_number: result.number, p_registered_office: result.registeredOffice });
    if (error) throw error;
    return { id: data.id, legalName: data.legal_name, companiesHouseNumber: data.companies_house_number, registeredOffice: data.registered_office, memberRole: 'owner', xeroTenantName: null, xeroScopes: [], setup: { xeroConnected: false, bankSourceConnected: false, baseCurrency: null, vatRegistered: null, vatScheme: null }, lastOpenedBankAccountId: null, bankAccounts: [] };
  }

  async deleteCompany(companyId: string, confirmation: string): Promise<void> {
    await invokeBackend('company-delete', { companyId, confirmation });
  }

  async updateCompany(company: Company): Promise<void> {
    const db = client();
    // Bank accounts mirror Xero and are written only by the server-side sync.
    const { error } = await db.from('companies').update({ base_currency: company.setup.baseCurrency, vat_registered: company.setup.vatRegistered, vat_scheme: company.setup.vatScheme }).eq('id', company.id);
    if (error) throw error;
  }

  async importLines(companyId: string, bankAccountId: string, csv: string): Promise<{ imported: number; errors: string[] }> {
    const parsed = importStatementCsv(csv, { companyId, bankAccountId });
    const db = client();
    const { data: userResult } = await db.auth.getUser();
    const { data: ingestion, error: ingestionError } = await db.from('ingestion_runs').insert({
      company_id: companyId, bank_account_id: bankAccountId, source: 'csv', status: 'processing',
      rejected_count: parsed.errors.length, error_summary: parsed.errors, created_by: userResult.user?.id ?? null
    }).select('id').single();
    if (ingestionError || !ingestion) throw ingestionError ?? new Error('Could not start the import');
    let imported = 0;
    try {
      if (parsed.lines.length) {
        const { data, error } = await db.from('statement_lines').upsert(parsed.lines.map(line => ({ company_id: line.companyId, bank_account_id: line.bankAccountId, ingestion_run_id: ingestion.id, posted_at: line.postedAt, amount_minor: line.amountMinor, currency: line.currency, payee: line.payee, description: line.description, reference: line.reference, dedupe_key: line.dedupeKey, status: line.status, note: line.note })), { onConflict: 'bank_account_id,dedupe_key', ignoreDuplicates: true }).select('id');
        if (error) throw error;
        imported = data?.length ?? 0;
      }
      const { error: completionError } = await db.from('ingestion_runs').update({ status: 'complete', imported_count: imported, completed_at: new Date().toISOString() }).eq('id', ingestion.id);
      if (completionError) throw completionError;
      void invokeBackend('agent-analysis-control', { companyId, action: 'kick' }).catch(() => undefined);
    } catch (error) {
      await db.from('ingestion_runs').update({ status: 'failed', error_summary: [...parsed.errors, { message: error instanceof Error ? error.message : 'Import failed' }], completed_at: new Date().toISOString() }).eq('id', ingestion.id);
      throw error;
    }
    return { imported, errors: parsed.errors.map(error => `Row ${error.row}: ${error.message}`) };
  }

  async uploadStatement(companyId: string, bankAccountId: string, file: File): Promise<StatementImport> {
    const form = new FormData();
    form.set('companyId', companyId);
    form.set('bankAccountId', bankAccountId);
    form.set('file', file);
    const response = await invokeBackendForm<{ statementImport: Record<string, any> }>('statement-upload', form);
    return mapStatementImport(response.statementImport);
  }

  async confirmStatementImport(companyId: string, importId: string): Promise<{ status: 'complete'; imported: number; duplicates: number }> {
    return invokeBackend('statement-import-confirm', { companyId, importId });
  }

  async deleteStatementImport(companyId: string, importId: string): Promise<StatementImportDeletionResult> {
    const response = await invokeBackend<{ filename: string; deletedLines: number; reopenedLines: number }>('statement-import-delete', { companyId, importId });
    return { filename: response.filename, deletedLines: Number(response.deletedLines ?? 0), reopenedLines: Number(response.reopenedLines ?? 0) };
  }

  async enqueueAnalysis(companyId: string, bankAccountId?: string): Promise<{ batchId: string; queued: number }> {
    return invokeBackend<{ batchId: string; queued: number }>('agent-analysis-control', { companyId, bankAccountId, action: 'backfill' });
  }

  async enqueueXeroObservation(companyId: string): Promise<{ jobId: string; scheduled: boolean }> {
    return invokeBackend<{ jobId: string; scheduled: boolean }>('xero-observation-control', { companyId });
  }

  async getXeroCandidateOptions(companyId: string): Promise<XeroCandidateOptions> {
    return invokeBackend<XeroCandidateOptions>('xero-candidate-options', { companyId });
  }

  async getXeroAttachments(companyId: string, entityType: 'invoice' | 'bank_transaction', entityId: string): Promise<XeroAttachmentInfo[]> {
    return (await invokeBackend<{ attachments: XeroAttachmentInfo[] }>('xero-entity-attachments', { companyId, entityType, entityId })).attachments;
  }

  async prepare(request: PrepareRequest): Promise<void> {
    await invokeBackend('xero-prepare-candidate', { ...request, candidate: request.candidate ?? {} });
  }

  async observe(candidateSetId: string, _observation: XeroObservation): Promise<void> {
    await invokeBackend('xero-observe-candidate', { candidateSetId });
  }

  async startXeroConnection(companyId: string): Promise<string> {
    const response = await invokeBackend<{ url: string }>('xero-oauth-start', { companyId });
    return response.url;
  }

  async preflightXeroReconciliation(companyId: string, lineIds: string[]): Promise<XeroPreflightResponse> {
    return invokeBackend<XeroPreflightResponse>('xero-reconcile-preflight', { companyId, lineIds });
  }

  async bootstrapAgent(companyId: string): Promise<AgentThread> {
    return (await invokeBackend<{ thread: AgentThread }>('agent-bootstrap', { companyId })).thread;
  }

  async runShadowAgent(companyId: string, lineId: string): Promise<AgentThread> {
    return (await invokeBackend<{ thread: AgentThread }>('agent-shadow', { companyId, lineId })).thread;
  }

  async getAgentThread(companyId: string, lineId?: string): Promise<AgentThread | null> {
    return (await invokeBackend<{ thread: AgentThread | null }>('agent-thread', lineId ? { companyId, lineId, kind: 'line' } : { companyId, kind: 'bootstrap' })).thread;
  }

  async ensureHandbookPropagation(companyId: string, lineId: string, runId: string): Promise<void> {
    await invokeBackend('agent-propagate-handbook', { companyId, lineId, runId });
  }

  async continueAgent(request: ContinueAgentRequest): Promise<AgentThread> {
    return (await invokeBackend<{ thread: AgentThread }>('agent-continue', { ...request })).thread;
  }

  async uploadDocument(request: UploadDocumentRequest): Promise<{ thread?: AgentThread; document: LineDocument }> {
    const form = new FormData();
    form.set('companyId', request.companyId);
    form.set('lineId', request.lineId);
    form.set('runId', request.runId);
    form.set('statusVersion', String(request.statusVersion));
    form.set('file', request.file);
    const response = await invokeBackendForm<{ thread?: AgentThread; document: Record<string, any> }>('agent-upload-document', form);
    return { thread: response.thread, document: mapDocument(response.document) };
  }

  async retryDocumentAnalysis(request: AnalyseDocumentRequest): Promise<{ thread?: AgentThread; document: LineDocument }> {
    const response = await invokeBackend<{ thread?: AgentThread; document: Record<string, any> }>('agent-analyse-document', { ...request });
    return { thread: response.thread, document: mapDocument(response.document) };
  }

  async syncDocumentToXero(companyId: string, documentId: string): Promise<LineDocument> {
    const response = await invokeBackend<{ document: Record<string, any> }>('xero-sync-document', { companyId, documentId });
    return mapDocument(response.document);
  }

  async acceptAgentMatch(request: AcceptAgentMatchRequest): Promise<AcceptAgentCreateResult> {
    return await invokeBackend<AcceptAgentCreateResult>('agent-accept-match', { ...request });
  }

  async acceptAgentCreate(request: AcceptAgentMatchRequest): Promise<AcceptAgentCreateResult> {
    return await invokeBackend<AcceptAgentCreateResult>('agent-accept-create', { ...request });
  }

  async createCompanyChat(companyId: string, firstMessage: string): Promise<CompanyChat> {
    const message = firstMessage.trim();
    if (!message) throw new Error('Enter a message to start a chat');
    const { data: auth } = await client().auth.getUser();
    if (!auth.user) throw new Error('Your session has expired. Sign in again to continue.');
    const title = message.replace(/\s+/g, ' ').slice(0, 72);
    const { data, error } = await client().from('company_chats').insert({ company_id: companyId, title, created_by: auth.user.id }).select('*').single();
    if (error) throw error;
    return {
      id: data.id, companyId: data.company_id, title: data.title, createdBy: data.created_by,
      latestRunId: data.latest_run_id, running: Boolean(data.running_run_id), lastError: data.last_error,
      createdAt: data.created_at, updatedAt: data.updated_at
    };
  }

  async getCompanyChatThread(companyId: string, chatId: string): Promise<CompanyChatThread | null> {
    return (await invokeBackend<{ thread: CompanyChatThread | null }>('company-chat-thread', { companyId, chatId })).thread;
  }

  async resetDemo(): Promise<void> {
    throw new Error('Reset is only available in local demo mode');
  }
}
