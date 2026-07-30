import { json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/company-access.ts';
import { DOCUMENT_BUCKET } from '../_shared/documents.ts';
import { extractStatement } from '../_shared/statement-extraction.ts';
import { addStatementDedupeKeys, sameTransactionSet, statementIdentityMatches, validateStatementExtraction, type StatementExtraction, type StatementValidation } from '../_shared/statement-import-validation.ts';

type Claim = { importId: string; companyId: string; bankAccountId: string; attempt: number; leaseToken: string };
type Row = Record<string, any>;

function authorised(request: Request): boolean {
  const expected = Deno.env.get('AGENT_RUNNER_SECRET');
  const supplied = request.headers.get('x-workbench-runner-secret');
  return Boolean(expected && supplied && expected === supplied);
}

function scheduleWorker(functionName: 'statement-import-worker' | 'agent-analysis-worker'): void {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('AGENT_RUNNER_SECRET');
  if (!baseUrl || !secret) return;
  const task = fetch(`${baseUrl}/functions/v1/${functionName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-runner-secret': secret }, body: '{}'
  }).then(response => {
    if (!response.ok) console.error(`${functionName} follow-up failed`, response.status);
  }).catch(error => console.error(`${functionName} follow-up failed`, error));
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

async function finish(service: any, claim: Claim, outcome: 'ready' | 'retryable' | 'failed', extraction?: StatementExtraction, validation?: StatementValidation, error?: string) {
  const result = await service.rpc('finish_statement_import', {
    p_import_id: claim.importId,
    p_lease_token: claim.leaseToken,
    p_outcome: outcome,
    p_extraction: extraction ?? null,
    p_validation: validation ?? null,
    p_error: error ?? null
  });
  if (result.error) throw new Error(`Could not finish statement import: ${result.error.message}`);
}

async function download(service: any, storageKey: string): Promise<Uint8Array> {
  const result = await service.storage.from(DOCUMENT_BUCKET).download(storageKey);
  if (result.error || !result.data) throw new Error(`Could not read the statement: ${result.error?.message ?? 'file missing'}`);
  return new Uint8Array(await result.data.arrayBuffer());
}

async function processClaim(service: any, claim: Claim) {
  try {
    const [importResult, profileResult] = await Promise.all([
      service.from('statement_imports').select('*').eq('id', claim.importId).eq('company_id', claim.companyId).maybeSingle(),
      service.from('statement_import_profiles').select('*').eq('bank_account_id', claim.bankAccountId).eq('company_id', claim.companyId).maybeSingle()
    ]);
    if (importResult.error || profileResult.error) throw new Error(importResult.error?.message ?? profileResult.error?.message);
    if (!importResult.data) {
      await finish(service, claim, 'failed', undefined, undefined, 'Statement import no longer exists');
      return { importId: claim.importId, outcome: 'failed' };
    }
    const row = importResult.data as Row;
    const bytes = await download(service, String(row.storage_key));
    const isVisualDocument = ['application/pdf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(String(row.mime_type));
    const outputs = isVisualDocument
      ? await Promise.all([
        extractStatement(bytes, String(row.mime_type), String(row.filename)),
        extractStatement(bytes, String(row.mime_type), String(row.filename), 'Perform an independent second extraction for completeness checking.')
      ])
      : [await extractStatement(bytes, String(row.mime_type), String(row.filename))];
    let extraction = outputs[0];
    let validation = validateStatementExtraction(extraction);
    if (!validation.valid) {
      extraction = await extractStatement(bytes, String(row.mime_type), String(row.filename), validation.errors.join('\n'));
      validation = validateStatementExtraction(extraction);
    }
    if (!validation.valid) {
      await finish(service, claim, 'failed', extraction, validation, validation.errors.join(' '));
      return { importId: claim.importId, outcome: 'failed', errors: validation.errors };
    }
    if (outputs.length > 1 && validation.proofLevel === 'structural') {
      const secondValidation = validateStatementExtraction(outputs[1]);
      if (!secondValidation.valid || !sameTransactionSet(extraction, outputs[1])) {
        const failedValidation: StatementValidation = {
          ...validation,
          valid: false,
          errors: [...validation.errors, 'Two independent readings of this statement did not produce the same transaction set.']
        };
        await finish(service, claim, 'failed', extraction, failedValidation, failedValidation.errors.join(' '));
        return { importId: claim.importId, outcome: 'failed', errors: failedValidation.errors };
      }
      validation = { ...validation, proofLevel: 'cross_checked', checks: [...validation.checks, { name: 'independent_extraction', passed: true, detail: 'Two independent extractions agreed exactly.' }] };
    }
    extraction = await addStatementDedupeKeys(extraction, claim.bankAccountId);
    await finish(service, claim, 'ready', extraction, validation);

    const canAutoCommit = Boolean(profileResult.data)
      && validation.proofLevel !== 'structural'
      && statementIdentityMatches(extraction, profileResult.data);
    if (canAutoCommit) {
      const committed = await service.rpc('commit_statement_import', { p_import_id: claim.importId, p_confirm_profile: false });
      if (committed.error) throw new Error(`Could not commit the verified statement: ${committed.error.message}`);
      scheduleWorker('agent-analysis-worker');
      return { importId: claim.importId, outcome: 'complete', ...committed.data };
    }
    return { importId: claim.importId, outcome: 'awaiting_confirmation', proofLevel: validation.proofLevel };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Statement extraction failed';
    console.error('statement import failed', { importId: claim.importId, attempt: claim.attempt, message, stack: error instanceof Error ? error.stack : undefined });
    try { await finish(service, claim, claim.attempt >= 3 ? 'failed' : 'retryable', undefined, undefined, message); }
    catch (finishError) { console.error('statement import finish failed', finishError); }
    return { importId: claim.importId, outcome: claim.attempt >= 3 ? 'failed' : 'retryable', error: message };
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!authorised(request)) return json({ error: 'Runner authentication failed' }, 401);
  try {
    const service = serviceClient();
    const { data, error } = await service.rpc('claim_statement_imports', { p_limit: 2, p_lease_seconds: 260 });
    if (error) throw new Error(error.message);
    const claims = (Array.isArray(data) ? data : []) as Claim[];
    const results = await Promise.all(claims.map(claim => processClaim(service, claim)));
    if (claims.length) scheduleWorker('statement-import-worker');
    return json({ claimed: claims.length, results });
  } catch (error) {
    console.error('statement-import-worker failed', error);
    return json({ error: error instanceof Error ? error.message : 'Statement import worker failed' }, 502);
  }
});
