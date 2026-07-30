import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson } from '../_shared/agent-artifacts.ts';
import { findCurrentXeroCandidates, getXeroReferenceData } from '../_shared/agent-xero.ts';
import { validateNewXeroCandidate } from '../_shared/agent-validator.ts';
import { preflightXeroReconciliation } from '../_shared/xero-preflight.ts';
import { scheduleAcceptedHandbookPropagation } from '../_shared/agent-propagation.ts';

type Row = Record<string, any>;

function responseFrom(error: unknown) {
  if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
  return json({ error: error instanceof Error ? error.message : 'Could not validate the Xero candidate' }, 502);
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
    if (!thread || thread.kind !== 'line' || thread.runId !== input.runId) return json({ error: 'The agent recommendation is stale; refresh or continue the conversation' }, 409);
    if (lineResult.error || !lineResult.data) return json({ error: lineResult.error?.message ?? 'Statement line not found' }, 404);
    const line = lineResult.data as Row;
    const { data: bankAccount, error: bankError } = await service.from('bank_accounts').select('id,xero_account_id').eq('company_id', input.companyId).eq('id', line.bank_account_id).maybeSingle();
    if (bankError || !bankAccount) return json({ error: bankError?.message ?? 'Bank account not found' }, 409);
    if (companyResult.error || !companyResult.data || companyResult.data.base_currency !== 'GBP' || companyResult.data.vat_registered === null || !companyResult.data.vat_scheme) return json({ error: 'Complete the blocking company accounting settings before preparing a candidate' }, 409);
    if (connectionResult.error || !connectionResult.data) return json({ error: 'Xero is not connected' }, 409);
    if (!bankAccount.xero_account_id) return json({ error: 'Map this statement source to a Xero bank account first' }, 409);
    if (line.status_version !== input.statusVersion || line.active_candidate_set_id || ['prepared', 'reconciled'].includes(line.status)) return json({ error: 'The statement line changed; refresh before using the recommendation' }, 409);
    if (thread.workflowProjection?.statusVersion !== line.status_version) return json({ error: 'The saved agent run was produced for an older statement-line version' }, 409);
    const artifactLine = thread.input?.statementLine;
    if (!artifactLine || artifactLine.id !== line.id) return json({ error: 'The saved agent thread belongs to a different statement line' }, 409);

    const recommendation = thread.finalOutput as Row;
    if (recommendation.outcome !== 'recommend_candidate' || recommendation.proposedOperation !== 'create_new') return json({ error: 'This agent run does not recommend creating a new Xero record' }, 422);

    const [preflight] = await preflightXeroReconciliation(service, input.companyId, [input.lineId], userId);
    if (preflight?.outcome === 'reconciled') return json({ error: 'Xero already reports this bank line as reconciled. Workbench linked the existing ledger movement and did not create anything.', preflight }, 409);
    if (preflight?.outcome === 'ambiguous') return json({ error: 'A possible existing Xero reconciliation needs review before Workbench can create anything.', preflight }, 409);

    // Refresh tokens rotate, so perform these two Xero reads serially.
    const freshSearch = await findCurrentXeroCandidates(service, input.companyId, { amountMinor: Number(line.amount_minor), postedAt: String(line.posted_at), payee: String(line.payee) });
    const referenceData = await getXeroReferenceData(service, input.companyId);
    const validation = validateNewXeroCandidate({ line: { amountMinor: Number(line.amount_minor) }, recommendation, currentCandidates: freshSearch.candidates as Row[], referenceData });
    if (!validation.valid) return json({ error: validation.failure.explanation, validation: validation.failure }, 409);

    const authorization = request.headers.get('authorization');
    if (!authorization) return json({ error: 'Invalid or expired session' }, 401);
    const response = await fetch(`${Deno.env.get('SUPABASE_URL')!}/functions/v1/xero-prepare-candidate`, {
      method: 'POST',
      headers: {
        authorization,
        apikey: Deno.env.get('SUPABASE_ANON_KEY')!,
        'content-type': 'application/json',
        'x-workbench-agent-run-id': thread.runId
      },
      body: JSON.stringify({ companyId: input.companyId, lineId: input.lineId, kind: validation.kind, candidate: validation.candidate })
    });
    const payload = await response.json();
    if (!response.ok) return json(payload, response.status);
    scheduleAcceptedHandbookPropagation(service, input.companyId, line, thread);
    return json({ ...payload, validation: { valid: true, ruleset: 'new-xero-candidate-v1', checked: ['fresh_candidate_search', 'active_xero_references', 'line_version', 'company_setup'] } }, response.status);
  } catch (error) {
    console.error('agent-accept-create failed', error);
    return responseFrom(error);
  }
});
