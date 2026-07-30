import { Agent, run, tool, user } from 'npm:@openai/agents@0.13.5';
import { z } from 'npm:zod@4.4.3';
import { artifactPaths, ensureHandbook, listHandbookEntries, publishLatestThread, readText, upsertHandbookEntry, writeThreadArtifact, writeThreadRun } from './agent-artifacts.ts';
import { fetchHmrcPage, searchHmrc } from './agent-hmrc.ts';
import { fetchInspectableXeroAttachments, findCurrentXeroCandidates, findXeroCandidatesInSnapshot, getXeroHistorySummary, getXeroReferenceData, refreshXeroHistorySummary, type XeroAnalysisSnapshot } from './agent-xero.ts';
import { archiveXeroEvidence, bytesDataUrl, documentUserContent, downloadDocument, hydrateDocumentHistory, sanitizeDocumentHistory, sha256Hex, xeroEvidenceStorageKey, xeroEvidenceUri, type StoredDocument } from './documents.ts';

type Service = any;

const MODEL = Deno.env.get('OPENAI_AGENT_MODEL') ?? 'gpt-5.6';

function memoryTools(service: Service, companyId: string, allowWrites = true) {
  const tools = [
    tool({
      name: 'list_handbook_entries',
      description: 'List the company-specific bookkeeping memory entries.',
      parameters: z.object({}),
      execute: async () => ({ index: await ensureHandbook(service, companyId), entries: await listHandbookEntries(service, companyId) })
    }),
    tool({
      name: 'read_handbook_entry',
      description: 'Read one company-specific bookkeeping memory entry by lowercase kebab-case name.',
      parameters: z.object({ name: z.string() }),
      execute: async ({ name }) => ({ name, content: await readText(service, artifactPaths.handbookEntry(companyId, name)) })
    })
  ];
  if (allowWrites) tools.push(tool({
      name: 'upsert_handbook_entry',
      description: 'Create or refine one durable company-specific memory entry. Use lowercase kebab-case and end content with Related: ... . Do not save one-off guesses as rules.',
      parameters: z.object({ name: z.string(), content: z.string() }),
      execute: async ({ name, content }) => { await upsertHandbookEntry(service, companyId, name, content); return { saved: name }; }
    }));
  return tools;
}

function researchTools(service: Service, companyId: string, snapshot?: XeroAnalysisSnapshot) {
  return [
    tool({
      name: 'get_xero_reference_data',
      description: 'Get current read-only Xero accounts, bank accounts, contacts and tax rates with valid IDs/codes.',
      parameters: z.object({}),
      execute: async () => snapshot?.referenceData ?? await getXeroReferenceData(service, companyId)
    }),
    tool({
      name: 'get_xero_history_summary',
      description: 'Get the cached aggregate and representative examples from the last 12 months of Xero history.',
      parameters: z.object({}),
      execute: async () => snapshot?.historySummary ?? await getXeroHistorySummary(service, companyId)
    }),
    tool({
      name: 'search_hmrc',
      description: 'Search GOV.UK for relevant HMRC manuals or guidance. Use when tax treatment is material or uncertain.',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => await searchHmrc(query)
    }),
    tool({
      name: 'fetch_hmrc_page',
      description: 'Fetch readable text from an HTTPS GOV.UK page returned by search_hmrc.',
      parameters: z.object({ url: z.string() }),
      execute: async ({ url }) => await fetchHmrcPage(url)
    })
  ];
}

function lineTools(service: Service, companyId: string, statementLine: Record<string, unknown>, snapshot?: XeroAnalysisSnapshot) {
  return [
    tool({
      name: 'find_current_xero_candidates',
      description: 'Freshly search current unreconciled authorised Xero bank transactions, open authorised bills/invoices and unresolved bank transfers for this exact statement line. Call this before proposing create_new or match_existing.',
      parameters: z.object({}),
      execute: async () => snapshot
        ? findXeroCandidatesInSnapshot(snapshot, { amountMinor: Number(statementLine.amount_minor), postedAt: String(statementLine.posted_at), payee: String(statementLine.payee ?? '') })
        : await findCurrentXeroCandidates(service, companyId, { amountMinor: Number(statementLine.amount_minor), postedAt: String(statementLine.posted_at), payee: String(statementLine.payee ?? '') })
    }),
    tool({
      name: 'find_workbench_transfer_pairs',
      description: 'Find other Workbench statement lines that could be the equal-and-opposite side of this transfer. Returns exact same-date, opposite-amount lines in a different bank account.',
      parameters: z.object({}),
      execute: async () => {
        const { data, error } = await service.from('statement_lines').select('id,bank_account_id,posted_at,amount_minor,payee,description,reference,status,active_candidate_set_id').eq('company_id', companyId).eq('posted_at', statementLine.posted_at).eq('amount_minor', -Number(statementLine.amount_minor)).neq('id', statementLine.id).is('active_candidate_set_id', null);
        if (error) throw new Error(error.message);
        return { pairs: (data ?? []).filter((line: Record<string, unknown>) => line.bank_account_id !== statementLine.bank_account_id) };
      }
    })
  ];
}

function companyTools(service: Service, companyId: string) {
  return [
    tool({
      name: 'get_company_overview',
      description: 'Read the company, its setup, bank accounts and current statement-line status totals from Workbench.',
      parameters: z.object({}),
      execute: async () => {
        const [companyResult, accountsResult, linesResult] = await Promise.all([
          service.from('companies').select('id,legal_name,companies_house_number,registered_office,base_currency,vat_registered,vat_scheme').eq('id', companyId).single(),
          service.from('bank_accounts').select('id,name,currency,source,xero_account_id').eq('company_id', companyId).order('created_at'),
          service.from('statement_lines').select('status').eq('company_id', companyId)
        ]);
        const error = [companyResult, accountsResult, linesResult].find(result => result.error)?.error;
        if (error) throw new Error(error.message);
        const totals: Record<string, number> = {};
        for (const line of linesResult.data ?? []) totals[line.status] = (totals[line.status] ?? 0) + 1;
        return { company: companyResult.data, bankAccounts: accountsResult.data ?? [], statementLineTotals: totals };
      }
    }),
    tool({
      name: 'search_statement_lines',
      description: 'Search this company’s Workbench statement lines by text, status and date. Results are capped and newest first.',
      parameters: z.object({
        query: z.string().optional(),
        status: z.enum(['new', 'processing', 'needs_you', 'waiting_doc', 'prepared', 'reconciled']).optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional()
      }),
      execute: async ({ query, status, dateFrom, dateTo, limit }) => {
        let request = service.from('statement_lines')
          .select('id,bank_account_id,posted_at,amount_minor,currency,payee,description,reference,status,status_version,active_candidate_set_id,note')
          .eq('company_id', companyId)
          .order('posted_at', { ascending: false })
          .limit(query ? 200 : (limit ?? 25));
        if (status) request = request.eq('status', status);
        if (dateFrom) request = request.gte('posted_at', dateFrom);
        if (dateTo) request = request.lte('posted_at', dateTo);
        const { data, error } = await request;
        if (error) throw new Error(error.message);
        const needle = query?.trim().toLocaleLowerCase('en-GB');
        const filtered = needle ? (data ?? []).filter((line: Record<string, unknown>) =>
          [line.payee, line.description, line.reference, line.note].some(value => String(value ?? '').toLocaleLowerCase('en-GB').includes(needle))
        ) : (data ?? []);
        return { lines: filtered.slice(0, limit ?? 25), truncated: filtered.length > (limit ?? 25) };
      }
    }),
    tool({
      name: 'get_statement_line_context',
      description: 'Read one statement line with its bank account, workflow events, active candidate, Xero mappings, document metadata and latest line-agent conclusion.',
      parameters: z.object({ lineId: z.string() }),
      execute: async ({ lineId }) => {
        const lineResult = await service.from('statement_lines').select('*').eq('company_id', companyId).eq('id', lineId).maybeSingle();
        if (lineResult.error) throw new Error(lineResult.error.message);
        if (!lineResult.data) throw new Error('Statement line not found');
        const line = lineResult.data;
        const [bankResult, eventsResult, documentsResult, thread] = await Promise.all([
          service.from('bank_accounts').select('id,name,currency,source,xero_account_id').eq('company_id', companyId).eq('id', line.bank_account_id).maybeSingle(),
          service.from('line_events').select('from_status,to_status,reason,source,metadata,created_at').eq('company_id', companyId).eq('statement_line_id', lineId).order('created_at', { ascending: false }).limit(50),
          service.from('documents').select('id,filename,mime_type,byte_size,analysis_status,analysis_error,xero_object_type,xero_object_id,xero_uploaded_at,xero_upload_error,created_at').eq('company_id', companyId).eq('statement_line_id', lineId).order('created_at'),
          readText(service, artifactPaths.lineThread(companyId, lineId))
        ]);
        const candidateResult = line.active_candidate_set_id
          ? await service.from('candidate_sets').select('id,kind,status,attempt_number,correlation_token,invalidation_reason,candidate_set_lines(*),xero_objects(*)').eq('company_id', companyId).eq('id', line.active_candidate_set_id).maybeSingle()
          : { data: null, error: null };
        const error = [bankResult, eventsResult, documentsResult, candidateResult].find(result => result.error)?.error;
        if (error) throw new Error(error.message);
        let lineAgentConclusion = null;
        if (thread) {
          const parsed = JSON.parse(thread) as Record<string, any>;
          lineAgentConclusion = { runId: parsed.runId, createdAt: parsed.createdAt, finalOutput: parsed.finalOutput };
        }
        return { line, bankAccount: bankResult.data, events: eventsResult.data ?? [], documents: documentsResult.data ?? [], activeCandidate: candidateResult.data, lineAgentConclusion };
      }
    })
  ];
}

function companyChatAgent(service: Service, companyId: string) {
  return new Agent({
    name: 'Workbench company assistant',
    model: MODEL,
    modelSettings: { reasoning: { effort: 'medium' }, text: { verbosity: 'low' }, parallelToolCalls: false },
    instructions: `Help a bookkeeper understand and operate one UK company in Workbench.

You share the same company handbook and accounting research tools as the bank-line analyst. Read relevant handbook entries before answering company-specific bookkeeping questions. You may update the handbook when the user supplies or confirms a durable company rule or explicitly asks you to remember something. User-originated handbook updates are immediately approved; do not save guesses or one-off transaction decisions as general rules.

Use the Workbench tools to inspect current company data rather than guessing. Use Xero reference data and history for accounting context, and GOV.UK HMRC sources when tax treatment is material or uncertain. Keep searches bounded and fetch detailed statement-line context only when needed.

This conversation is read-only for operational and Xero state. You have no tool to create, approve, alter or reconcile a statement line or Xero entity. Never claim an action happened when it did not. When action is required, identify the relevant statement line and explain that its recommendation must be reviewed in the Reconcile tab.

Answer the latest question directly in clear UK English. Distinguish authoritative current data, handbook rules, historical patterns and your own inference. Do not expose internal tool names or raw implementation details unless the user asks.` ,
    tools: [...memoryTools(service, companyId, true), ...researchTools(service, companyId), ...companyTools(service, companyId)]
  });
}

export async function startCompanyChatAgentStream(service: Service, companyId: string, previousThread: Record<string, any> | null, message: string) {
  await ensureHandbook(service, companyId);
  const input = previousThread?.history;
  if (previousThread && !Array.isArray(input)) throw new Error('The saved company chat cannot be continued');
  return await run(
    companyChatAgent(service, companyId),
    previousThread ? [...input, user(message)] as any[] : message,
    { stream: true, maxTurns: 16, signal: AbortSignal.timeout(380_000) }
  );
}

const bootstrapOutput = z.object({
  summary: z.string(),
  entriesCreatedOrUpdated: z.array(z.string()),
  caveats: z.array(z.string())
});

const recommendationOutput = z.object({
  outcome: z.enum(['recommend_candidate', 'needs_information', 'needs_review']),
  proposedOperation: z.enum(['create_new', 'match_existing', 'request_information', 'human_review']),
  candidateKind: z.enum(['bank_transaction', 'bill', 'invoice', 'transfer', 'none']),
  existingXeroEntityType: z.enum(['bank_transaction', 'invoice', 'transfer', 'none']),
  existingXeroEntityId: z.string(),
  existingXeroEntityNumber: z.string(),
  existingXeroMatchReason: z.string(),
  contactId: z.string(),
  contactName: z.string(),
  accountCode: z.string(),
  accountName: z.string(),
  taxType: z.string(),
  description: z.string(),
  reference: z.string(),
  documentDate: z.string(),
  dueDate: z.string(),
  reply: z.string(),
  summary: z.string(),
  evidence: z.array(z.object({ source: z.enum(['statement_line', 'document', 'xero_history', 'handbook', 'hmrc']), title: z.string(), detail: z.string(), url: z.string() })),
  questions: z.array(z.string())
});

function transcript(kind: 'bootstrap' | 'line', input: unknown, result: any, lineage?: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    kind,
    model: MODEL,
    createdAt: new Date().toISOString(),
    input,
    finalOutput: result.finalOutput,
    history: result.history,
    responseIds: result.rawResponses.map((response: { responseId?: string }) => response.responseId).filter(Boolean),
    ...(lineage ?? {})
  };
}

async function inspectRecommendedXeroEvidence(
  service: Service,
  companyId: string,
  statementLine: Record<string, unknown>,
  input: unknown,
  initialArtifact: ReturnType<typeof transcript>,
  existingDurableUris = new Map<string, string>(),
  priorXeroDocuments: Array<Record<string, unknown>> = []
) {
  const recommendation = initialArtifact.finalOutput as Record<string, unknown>;
  const withoutNewEvidence = () => {
    initialArtifact.history = sanitizeDocumentHistory(initialArtifact.history, existingDurableUris);
    return initialArtifact;
  };
  if (!['invoice', 'bank_transaction'].includes(String(recommendation.existingXeroEntityType)) || !recommendation.existingXeroEntityId) return withoutNewEvidence();
  const entityType = recommendation.existingXeroEntityType as 'invoice' | 'bank_transaction';
  const entityId = String(recommendation.existingXeroEntityId);
  if (priorXeroDocuments.some(document => document.entityType === entityType && document.entityId === entityId)) return withoutNewEvidence();
  const currentCandidates = await findCurrentXeroCandidates(service, companyId, { amountMinor: Number(statementLine.amount_minor), postedAt: String(statementLine.posted_at), payee: String(statementLine.payee ?? '') });
  const selected = currentCandidates.candidates.find(candidate => candidate.entityType === entityType && candidate.entityId === entityId);
  if (!selected) throw new Error('The recommended Xero entity changed before its evidence could be inspected');
  if (!selected.hasAttachments) return withoutNewEvidence();

  const files = await fetchInspectableXeroAttachments(service, companyId, entityType, entityId);
  if (!files.length) throw new Error('The recommended Xero entity has attachments, but none can be safely inspected');
  const durableUris = new Map(existingDurableUris);
  const evidence: Array<{ source: 'xero'; attachmentId: string; entityType: 'invoice' | 'bank_transaction'; entityId: string; filename: string; mimeType: string; byteSize: number; sha256: string }> = [];
  const content: Array<Record<string, unknown>> = [{
    type: 'input_text',
    text: `The recommended existing Xero ${entityType.replaceAll('_', ' ')} ${String(recommendation.existingXeroEntityNumber ?? entityId)} already has the following supporting evidence attached. Inspect every supplied file before returning the complete revised recommendation. Verify supplier, invoice number, dates, GBP total and VAT against both the statement line and the selected live candidate. Cite each inspected file with evidence source document. If the evidence conflicts, do not recommend the match.\n\nCurrent server-fetched candidates:\n${JSON.stringify(currentCandidates)}`
  }];
  for (const file of files) {
    const storageKey = xeroEvidenceStorageKey(companyId, entityId, file.attachmentId, file.filename);
    await archiveXeroEvidence(service, storageKey, file.bytes, file.mimeType);
    const dataUrl = bytesDataUrl(file.bytes, file.mimeType);
    durableUris.set(dataUrl, xeroEvidenceUri(storageKey));
    evidence.push({ source: 'xero', attachmentId: file.attachmentId, entityType, entityId, filename: file.filename, mimeType: file.mimeType, byteSize: file.byteSize, sha256: await sha256Hex(file.bytes) });
    content.push(file.mimeType === 'application/pdf'
      ? { type: 'input_file', file: dataUrl, filename: file.filename }
      : { type: 'input_image', image: dataUrl, detail: 'high' });
  }
  const result = await run(lineAgent(service, companyId, statementLine, 'document'), [...initialArtifact.history, user(content as any[])] as any[], { maxTurns: 3, signal: AbortSignal.timeout(115_000) });
  if (!result.finalOutput) throw new Error('Xero evidence analysis returned no output');
  const revised = result.finalOutput as { evidence?: Array<{ source?: string }> };
  if (!revised.evidence?.some(item => item.source === 'document')) throw new Error('The agent did not cite the Xero attachment it inspected');
  const artifact = transcript('line', input, result, {
    parentRunId: initialArtifact.runId,
    userMessage: `Inspected ${files.length} attachment${files.length === 1 ? '' : 's'} from Xero`,
    xeroDocuments: [...priorXeroDocuments, ...evidence],
    ...('reconsideration' in initialArtifact ? { reconsideration: initialArtifact.reconsideration } : {})
    , ...('batch' in initialArtifact ? { batch: initialArtifact.batch } : {})
  });
  artifact.history = sanitizeDocumentHistory(artifact.history, durableUris);
  return artifact;
}

function lineAgent(service: Service, companyId: string, statementLine: Record<string, unknown>, mode: 'interactive' | 'document' | 'reconsideration' | 'batch' = 'interactive', snapshot?: XeroAnalysisSnapshot) {
  return new Agent({
    name: 'Workbench bank line analyst',
    model: MODEL,
    modelSettings: mode === 'document'
      ? { reasoning: { effort: 'low' }, text: { verbosity: 'low' }, parallelToolCalls: false, maxTokens: 2200 }
      : { reasoning: { effort: 'medium' }, text: { verbosity: 'low' }, parallelToolCalls: false },
    outputType: recommendationOutput,
    instructions: `Recommend the next valid Xero candidate for one UK company bank statement line.

This is a read-only analysis conversation. You have no Xero write tool. Never say the line was prepared, reconciled or changed. Every genuine bank line must eventually be reconciled; there is no exclusion or ignore outcome.

Read the handbook index and relevant entries. Use Xero history and current reference data. You MUST call find_current_xero_candidates before returning create_new or match_existing. Never recommend create_new when an exact compatible existing Xero entity may already represent the line. Use find_workbench_transfer_pairs before proposing a transfer.

Use match_existing only with an exact entity ID returned by the fresh candidate tool. Copy its entity type, ID and number exactly and explain the match. Use create_new only when the fresh search found no compatible existing entity and the accounting treatment is complete. Use request_information when a missing document or fact prevents a valid treatment, and human_review for risky ambiguity that is already fully described.

When the bookkeeper supplies a document, inspect it as primary evidence. Verify that its supplier, date, currency and total are compatible with the statement line, identify the VAT treatment from the document rather than merchant-name assumptions, and cite it with evidence source document. If it does not belong to the line or remains insufficient, explain exactly what is missing.

For create_new bank transactions, bills and invoices, contactId, accountCode and taxType must all be non-empty values copied from the current Xero reference-data tool. A historical contact name without a current ContactID is not an executable recommendation. For a bill or invoice, set documentDate and dueDate to explicit YYYY-MM-DD values from the supporting document and put its supplier/customer document number in reference. Never substitute the bank-statement date for a document date merely because the bank line is the trigger. For other candidate kinds, return empty strings for documentDate and dueDate.

Always set reply to the direct, plain-language response to the latest user turn. For the first analysis, reply should state the conclusion or requested action. Also return the complete current recommendation separately in the other fields. When a follow-up is only a question and supplies no new evidence, preserve the prior recommendation fields and summary exactly; put the answer in reply. Revise the recommendation only when the user's facts, requested change, new evidence or fresh Xero state materially affect it. Re-check live Xero data whenever the requested change could affect the candidate. Treat prior conversation as context, not as proof that mutable Xero state is still current.

The current statement-line status is ${String(statementLine.status)}. If it is prepared or reconciled, treat the turn as post-decision review: answer questions and inspect new evidence without proposing a duplicate Xero record. Use human_review only when new evidence materially contradicts the existing treatment; never claim that conversation alone changed or reopened the accounting state.

Use GOV.UK HMRC sources when tax treatment is material or genuinely uncertain. A recommendation may concern a spend/receive bank transaction, authorised bill, authorised invoice, or transfer. Only return IDs, account codes and tax types that appeared in tool results. Explain evidence and uncertainty precisely. Save a handbook entry only for a genuinely durable new pattern, never for this one line's decision or a guess.${mode === 'document' ? '\n\nFor this document turn, the current Xero candidate search is included in the user input and no tools are exposed. Reuse a contact/account/tax identifier only if it already appeared in the saved thread history; the deterministic acceptance boundary will re-fetch and validate it.' : ''}${mode === 'reconsideration' ? '\n\nThis turn was triggered by a company-handbook change, not by a new user message on this line. Read the changed handbook entry and reassess the line. Do not write or revise handbook entries during this automatic reconsideration.' : ''}`,
    tools: mode === 'document' ? [] : [...memoryTools(service, companyId, !['reconsideration', 'batch'].includes(mode)), ...researchTools(service, companyId, snapshot), ...lineTools(service, companyId, statementLine, snapshot)]
  });
}

async function projectAgentReview(service: Service, companyId: string, statementLine: Record<string, unknown>, artifact: any) {
  const recommendation = artifact.finalOutput as { outcome: string; proposedOperation: string; summary: string };
  const threadPath = artifactPaths.lineThread(companyId, String(statementLine.id));
  const durableBatchRun = Boolean(artifact.batch?.jobId);
  if (durableBatchRun) await writeThreadRun(service, threadPath, artifact);
  const { data: projection, error: projectionError } = await service.rpc('mark_agent_review_required', {
    p_company_id: companyId,
    p_line_id: String(statementLine.id),
    p_expected_status_version: Number(statementLine.status_version),
    p_run_id: artifact.runId,
    p_outcome: recommendation.outcome,
    p_proposed_operation: recommendation.proposedOperation,
    p_summary: recommendation.summary
  });
  if (projectionError || !projection) throw new Error(projectionError?.message ?? 'Could not mark the analysis ready for review');
  artifact.workflowProjection = { status: 'needs_you', statusVersion: Number(projection.statusVersion), note: String(projection.note) };
  if (durableBatchRun) {
    await writeThreadRun(service, threadPath, artifact);
    await publishLatestThread(service, threadPath, artifact);
  } else {
    await writeThreadArtifact(service, threadPath, artifact);
  }
  return artifact;
}

async function persistLineOutcome(service: Service, companyId: string, statementLine: Record<string, unknown>, artifact: any) {
  const resolved = Boolean(statementLine.active_candidate_set_id) || ['prepared', 'reconciled'].includes(String(statementLine.status));
  if (!resolved) return await projectAgentReview(service, companyId, statementLine, artifact);
  artifact.workflowProjection = {
    status: String(statementLine.status),
    statusVersion: Number(statementLine.status_version),
    note: String(statementLine.note ?? '')
  };
  await writeThreadArtifact(service, artifactPaths.lineThread(companyId, String(statementLine.id)), artifact);
  return artifact;
}

export async function bootstrapAgentMemory(service: Service, companyId: string) {
  await ensureHandbook(service, companyId);
  const history = await refreshXeroHistorySummary(service, companyId);
  const agent = new Agent({
    name: 'Workbench Xero history analyst',
    model: MODEL,
    modelSettings: { reasoning: { effort: 'medium' }, text: { verbosity: 'low' }, parallelToolCalls: false },
    outputType: bootstrapOutput,
    instructions: `Build useful, conservative company-specific bookkeeping memory from read-only Xero history.

Inspect the handbook first, then the Xero history summary and reference data. Identify recurring, well-supported bookkeeping patterns such as stable contact/account/tax combinations. Save only durable patterns, each as one concise handbook entry with provenance, limits, and a final Related: line. Do not infer policy from a single example. Do not write to Xero. Do not claim that historical treatment is necessarily correct. The handbook is free-form and should remain easy for a human to review and edit.` ,
    tools: [...memoryTools(service, companyId), ...researchTools(service, companyId)]
  });
  const input = { companyId, historyGeneratedAt: history.generatedAt, historyCounts: history.counts };
  const result = await run(agent, `Bootstrap the company handbook for this context:\n${JSON.stringify(input)}`, { maxTurns: 18 });
  if (!result.finalOutput) throw new Error('History bootstrap returned no output');
  const artifact = transcript('bootstrap', input, result);
  await writeThreadArtifact(service, artifactPaths.bootstrapThread(companyId), artifact);
  return artifact;
}

export async function runLineShadowAgent(service: Service, companyId: string, statementLine: Record<string, unknown>, company: Record<string, unknown>, bankAccount: Record<string, unknown>) {
  await ensureHandbook(service, companyId);
  const input = { company, bankAccount, statementLine };
  const result = await run(lineAgent(service, companyId, statementLine), `Analyse this bank statement line:\n${JSON.stringify(input)}`, { maxTurns: 16 });
  if (!result.finalOutput) throw new Error('Line analysis returned no output');
  const initialArtifact = transcript('line', input, result);
  const artifact = await inspectRecommendedXeroEvidence(service, companyId, statementLine, input, initialArtifact) as ReturnType<typeof transcript> & { workflowProjection?: { status: 'needs_you'; statusVersion: number; note: string } };
  return await persistLineOutcome(service, companyId, statementLine, artifact);
}

export async function runLineBatchAgent(
  service: Service,
  companyId: string,
  statementLine: Record<string, unknown>,
  company: Record<string, unknown>,
  bankAccount: Record<string, unknown>,
  snapshot: XeroAnalysisSnapshot,
  batch: { batchId: string; jobId: string; snapshotCreatedAt: string }
) {
  await ensureHandbook(service, companyId);
  const input = { company, bankAccount, statementLine, analysisSnapshot: { createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt } };
  const result = await run(
    lineAgent(service, companyId, statementLine, 'batch', snapshot),
    `Analyse this bank statement line using the immutable Xero batch snapshot exposed by the tools:\n${JSON.stringify(input)}`,
    { maxTurns: 16, signal: AbortSignal.timeout(115_000) }
  );
  if (!result.finalOutput) throw new Error('Batch line analysis returned no output');
  const initialArtifact = transcript('line', input, result, { batch });
  const artifact = await inspectRecommendedXeroEvidence(service, companyId, statementLine, input, initialArtifact) as ReturnType<typeof transcript> & { workflowProjection?: { status: 'needs_you'; statusVersion: number; note: string } };
  return await persistLineOutcome(service, companyId, statementLine, artifact);
}

export async function continueLineAgent(service: Service, companyId: string, statementLine: Record<string, unknown>, previousThread: Record<string, any>, message: string) {
  await ensureHandbook(service, companyId);
  if (!Array.isArray(previousThread.history)) throw new Error('The saved agent thread cannot be continued');
  const hydrated = await hydrateDocumentHistory(service, companyId, previousThread.history);
  const workflowContext = `Current authoritative Workbench state: ${String(statementLine.status)}${statementLine.active_candidate_set_id ? `, active candidate set ${String(statementLine.active_candidate_set_id)}` : ''}.\n\nUser message: ${message}`;
  const result = await run(lineAgent(service, companyId, statementLine), [...hydrated.history, user(workflowContext)] as any[], { maxTurns: 16 });
  if (!result.finalOutput) throw new Error('Agent continuation returned no output');
  const initialArtifact = transcript('line', previousThread.input, result, { parentRunId: String(previousThread.runId), userMessage: message, ...(Array.isArray(previousThread.xeroDocuments) ? { xeroDocuments: previousThread.xeroDocuments } : {}) });
  const artifact = await inspectRecommendedXeroEvidence(service, companyId, statementLine, previousThread.input, initialArtifact, hydrated.dataUrls, Array.isArray(previousThread.xeroDocuments) ? previousThread.xeroDocuments : []) as ReturnType<typeof transcript> & { workflowProjection?: { status: 'needs_you'; statusVersion: number; note: string } };
  return await persistLineOutcome(service, companyId, statementLine, artifact);
}

export interface HandbookReconsideration {
  sourceRunId: string;
  sourceLineId: string;
  handbookEntries: Array<{ name: string; content: string }>;
  reason: string;
}

export async function reconsiderLineForHandbookChange(
  service: Service,
  companyId: string,
  statementLine: Record<string, unknown>,
  company: Record<string, unknown>,
  bankAccount: Record<string, unknown>,
  previousThread: Record<string, any> | null,
  reconsideration: HandbookReconsideration
) {
  await ensureHandbook(service, companyId);
  const input = previousThread?.input ?? { company, bankAccount, statementLine };
  const systemEvent = `Workbench system event: the company handbook changed after another statement line was approved. Reassess this line using the handbook as the source of truth. This is not a user instruction on this line and does not approve any Xero action.\n\nChanged entries: ${reconsideration.handbookEntries.map(entry => entry.name).join(', ')}\nScreening reason: ${reconsideration.reason}`;
  let result;
  let hydrated: Awaited<ReturnType<typeof hydrateDocumentHistory>> | null = null;
  if (previousThread) {
    if (!Array.isArray(previousThread.history)) throw new Error('The saved agent thread cannot be reconsidered');
    hydrated = await hydrateDocumentHistory(service, companyId, previousThread.history);
    result = await run(lineAgent(service, companyId, statementLine, 'reconsideration'), [...hydrated.history, user(systemEvent)] as any[], { maxTurns: 16 });
  } else {
    result = await run(lineAgent(service, companyId, statementLine, 'reconsideration'), `${systemEvent}\n\nAnalyse this bank statement line:\n${JSON.stringify(input)}`, { maxTurns: 16 });
  }
  if (!result.finalOutput) throw new Error('Automatic line reconsideration returned no output');
  const priorXeroDocuments = Array.isArray(previousThread?.xeroDocuments) ? previousThread.xeroDocuments : [];
  const lineage = {
    ...(previousThread ? { parentRunId: String(previousThread.runId) } : {}),
    reconsideration,
    ...(priorXeroDocuments.length ? { xeroDocuments: priorXeroDocuments } : {})
  };
  const initialArtifact = transcript('line', input, result, lineage);
  const artifact = await inspectRecommendedXeroEvidence(
    service,
    companyId,
    statementLine,
    input,
    initialArtifact,
    hydrated?.dataUrls ?? new Map<string, string>(),
    priorXeroDocuments
  );
  return await persistLineOutcome(service, companyId, statementLine, artifact);
}

export async function continueLineAgentWithDocument(service: Service, companyId: string, statementLine: Record<string, unknown>, previousThread: Record<string, any>, document: StoredDocument) {
  await ensureHandbook(service, companyId);
  if (!Array.isArray(previousThread.history)) throw new Error('The saved agent thread cannot be continued');
  const hydrated = await hydrateDocumentHistory(service, companyId, previousThread.history);
  const [downloaded, currentCandidates] = await Promise.all([
    downloadDocument(service, document),
    findCurrentXeroCandidates(service, companyId, { amountMinor: Number(statementLine.amount_minor), postedAt: String(statementLine.posted_at), payee: String(statementLine.payee ?? '') })
  ]);
  hydrated.dataUrls.set(downloaded.dataUrl, `workbench://document/${document.id}`);
  const documentMessage = user(documentUserContent(document, downloaded.dataUrl, { currentCandidates }) as any[]);
  const result = await run(lineAgent(service, companyId, statementLine, 'document'), [...hydrated.history, documentMessage] as any[], { maxTurns: 3, signal: AbortSignal.timeout(115_000) });
  if (!result.finalOutput) throw new Error('Document analysis returned no output');
  const initialArtifact = transcript('line', previousThread.input, result, {
    parentRunId: String(previousThread.runId),
    userMessage: `Uploaded ${document.filename}`,
    document: { id: document.id, filename: document.filename, mimeType: document.mime_type, byteSize: document.byte_size, sha256: document.sha256 },
    ...(Array.isArray(previousThread.xeroDocuments) ? { xeroDocuments: previousThread.xeroDocuments } : {})
  });
  const artifact = await inspectRecommendedXeroEvidence(service, companyId, statementLine, previousThread.input, initialArtifact, hydrated.dataUrls, Array.isArray(previousThread.xeroDocuments) ? previousThread.xeroDocuments : []) as ReturnType<typeof transcript> & { workflowProjection?: { status: 'needs_you'; statusVersion: number; note: string }; history: unknown[] };
  return await persistLineOutcome(service, companyId, statementLine, artifact);
}
