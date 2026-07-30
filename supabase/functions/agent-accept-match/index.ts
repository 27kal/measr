import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson } from '../_shared/agent-artifacts.ts';
import { findCurrentXeroCandidates, getCurrentXeroEntity } from '../_shared/agent-xero.ts';
import { validateExistingXeroMatch } from '../_shared/agent-validator.ts';
import { sha256Json } from '../_shared/xero-recovery.ts';
import { preflightXeroReconciliation } from '../_shared/xero-preflight.ts';
import { syncCandidateDocumentsToXero } from '../_shared/documents.ts';
import { freshXeroAccessToken } from '../_shared/xero.ts';
import { scheduleAcceptedHandbookPropagation } from '../_shared/agent-propagation.ts';

type Row = Record<string, any>;

function responseFrom(error: unknown) {
  if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
  return json({ error: error instanceof Error ? error.message : 'Could not validate the Xero match' }, 502);
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; lineId?: string; runId?: string; statusVersion?: number };
    if (!input.companyId || !input.lineId || !input.runId || !Number.isInteger(input.statusVersion)) return json({ error: 'companyId, lineId, runId and statusVersion are required' }, 422);
    const { service, userId, role } = await requireCompanyAccess(request, input.companyId);
    if (role === 'viewer') return json({ error: 'Viewers cannot prepare bookkeeping candidates' }, 403);

    const [thread, lineResult, companyResult, connectionResult] = await Promise.all([
      readJson<Row>(service, artifactPaths.lineThread(input.companyId, input.lineId)),
      service.from('statement_lines').select('*').eq('company_id', input.companyId).eq('id', input.lineId).maybeSingle(),
      service.from('companies').select('base_currency,vat_registered,vat_scheme').eq('id', input.companyId).maybeSingle(),
      service.from('xero_connections').select('tenant_id').eq('company_id', input.companyId).is('disconnected_at', null).maybeSingle()
    ]);
    if (!thread || thread.kind !== 'line' || thread.runId !== input.runId) return json({ error: 'The agent recommendation is stale; run the analysis again' }, 409);
    if (lineResult.error || !lineResult.data) return json({ error: lineResult.error?.message ?? 'Statement line not found' }, 404);
    const line = lineResult.data as Row;
    const { data: bankAccount, error: bankError } = await service.from('bank_accounts').select('id,xero_account_id').eq('company_id', input.companyId).eq('id', line.bank_account_id).maybeSingle();
    if (bankError || !bankAccount) return json({ error: bankError?.message ?? 'Bank account not found' }, 409);
    if (companyResult.error || !companyResult.data || companyResult.data.base_currency !== 'GBP' || companyResult.data.vat_registered === null || !companyResult.data.vat_scheme) return json({ error: 'Complete the blocking company accounting settings before preparing a match' }, 409);
    if (connectionResult.error || !connectionResult.data) return json({ error: 'Xero is not connected' }, 409);
    if (!bankAccount.xero_account_id) return json({ error: 'Map this statement source to a Xero bank account first' }, 409);
    if (line.status_version !== input.statusVersion || line.active_candidate_set_id || ['prepared', 'reconciled'].includes(line.status)) return json({ error: 'The statement line changed; refresh and run the analysis again' }, 409);
    const artifactLine = thread.input?.statementLine;
    const threadStatusVersion = thread.workflowProjection?.statusVersion ?? artifactLine?.status_version;
    if (!artifactLine || artifactLine.id !== line.id || threadStatusVersion !== line.status_version) return json({ error: 'The saved agent run was produced for an older statement-line version' }, 409);

    const recommendation = thread.finalOutput as Row;
    if (recommendation.outcome !== 'recommend_candidate' || recommendation.proposedOperation !== 'match_existing') return json({ error: 'This agent run does not recommend an existing Xero match' }, 422);
    if (!/^[0-9a-f-]{36}$/i.test(String(recommendation.existingXeroEntityId ?? ''))) return json({ error: 'The recommendation does not contain a valid Xero entity ID' }, 422);
    if (!['invoice', 'bank_transaction'].includes(recommendation.existingXeroEntityType)) return json({ error: 'This existing Xero entity type is not executable yet' }, 422);

    const [preflight] = await preflightXeroReconciliation(service, input.companyId, [input.lineId], userId);
    if (preflight?.outcome === 'reconciled') return json({ error: 'Xero already reports this bank line as reconciled. Workbench linked the existing ledger movement.', preflight }, 409);
    if (preflight?.outcome === 'ambiguous') return json({ error: 'A possible existing Xero reconciliation needs review before this match can be used.', preflight }, 409);

    // Xero refresh tokens rotate. Keep Xero reads serial while the unrelated
    // local uniqueness check can happen before them.
    const existingMapping = await service.from('xero_objects').select('candidate_set_id').eq('company_id', input.companyId).eq('object_type', recommendation.existingXeroEntityType).eq('xero_object_id', recommendation.existingXeroEntityId).maybeSingle();
    if (existingMapping.error) throw new Error(existingMapping.error.message);
    if (existingMapping.data) return json({ error: 'This Xero entity is already mapped to another Workbench candidate' }, 409);
    const freshSearch = await findCurrentXeroCandidates(service, input.companyId, { amountMinor: Number(line.amount_minor), postedAt: String(line.posted_at), payee: String(line.payee) });
    const entity = await getCurrentXeroEntity(service, input.companyId, recommendation.existingXeroEntityType, recommendation.existingXeroEntityId);

    const validation = validateExistingXeroMatch({
      line: { amountMinor: Number(line.amount_minor), postedAt: String(line.posted_at), payee: String(line.payee), description: String(line.description), reference: String(line.reference) },
      xeroBankAccountId: String(bankAccount.xero_account_id), recommendation, currentCandidates: freshSearch.candidates as Row[], entity
    });
    if (!validation.valid) return json({ error: validation.failure.explanation, validation: validation.failure }, 409);

    const validatedAt = new Date().toISOString();
    const intent = {
      schemaVersion: 1, mode: 'match_existing', agentRunId: thread.runId,
      line: { id: line.id, statusVersion: line.status_version, bankAccountId: line.bank_account_id, postedAt: line.posted_at, amountMinor: Number(line.amount_minor), currency: line.currency },
      xero: { entityType: validation.objectType, entityId: recommendation.existingXeroEntityId, entityNumber: recommendation.existingXeroEntityNumber, status: entity.Status, selectedCandidate: validation.selectedCandidate },
      validation: { validatedAt, ruleset: 'existing-xero-match-v1', evidence: ['fresh_candidate_search', 'exact_entity_refetch', 'line_version', 'company_setup', 'local_uniqueness'] }
    };
    const fingerprint = await sha256Json(intent);
    const xeroObject = { objectType: validation.objectType, objectRole: validation.objectRole, xeroObjectId: recommendation.existingXeroEntityId, xeroStatus: entity.Status, isReconciled: Boolean(entity.IsReconciled), correlationChannels: ['local_only'], observedPayload: entity };
    const { data: committed, error: commitError } = await service.rpc('commit_validated_xero_match', {
      p_company_id: input.companyId, p_line_id: input.lineId, p_expected_status_version: input.statusVersion,
      p_kind: validation.kind, p_created_by: userId, p_preparation_request: intent,
      p_preparation_fingerprint: fingerprint, p_xero_object: xeroObject,
      p_event_metadata: { agentRunId: thread.runId, validationFingerprint: fingerprint, ruleset: 'existing-xero-match-v1' }
    });
    if (commitError) return json({ error: commitError.message }, 409);
    const attachmentTarget = validation.objectType === 'invoice'
      ? { endpoint: 'Invoices' as const, objectType: 'invoice' as const }
      : { endpoint: 'BankTransactions' as const, objectType: 'bank_transaction' as const };
    const attachments = await syncCandidateDocumentsToXero(
      service,
      input.companyId,
      [input.lineId],
      committed.candidateSetId,
      attachmentTarget.endpoint,
      attachmentTarget.objectType,
      recommendation.existingXeroEntityId,
      await freshXeroAccessToken(service, input.companyId),
      connectionResult.data.tenant_id
    );
    scheduleAcceptedHandbookPropagation(service, input.companyId, line, thread);
    return json({ candidateSetId: committed.candidateSetId, validation: { valid: true, fingerprint, ruleset: 'existing-xero-match-v1' }, alreadyCommitted: Boolean(committed.alreadyCommitted), attachments }, committed.alreadyCommitted ? 200 : 201);
  } catch (error) {
    console.error('agent-accept-match failed', error);
    return responseFrom(error);
  }
});
