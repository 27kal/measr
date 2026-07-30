import { randomUUID } from 'node:crypto';

// Guarded live harness: use only with the disposable Demo Company (UK) tenant.

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const projectRef = required('SUPABASE_PROJECT_REF');
const managementToken = required('SUPABASE_ACCESS_TOKEN');
const faultToken = required('XERO_FAILURE_INJECTION_TOKEN');
const userEmail = required('EXPERIMENT_USER_EMAIL');
const companyNumber = required('EXPERIMENT_COMPANY_NUMBER');
const experimentKind = process.env.EXPERIMENT_KIND ?? 'bank_transaction';
if (!['bank_transaction', 'bill', 'transfer'].includes(experimentKind)) throw new Error('EXPERIMENT_KIND must be bank_transaction, bill or transfer');
const projectUrl = `https://${projectRef}.supabase.co`;

async function responseJson(response, label) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

const keys = await responseJson(await fetch(`https://api.supabase.com/v1/projects/${projectRef}/api-keys?reveal=true`, {
  headers: { authorization: `Bearer ${managementToken}` }
}), 'Load project keys');
const keyValue = name => keys.find(key => key.name === name)?.api_key;
const anonymousKey = keyValue('anon');
const serviceKey = keyValue('service_role');
if (!anonymousKey || !serviceKey) throw new Error('Legacy anon and service-role keys are required for the experiment');

const serviceHeaders = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };
const link = await responseJson(await fetch(`${projectUrl}/auth/v1/admin/generate_link`, {
  method: 'POST', headers: serviceHeaders, body: JSON.stringify({ type: 'magiclink', email: userEmail })
}), 'Generate local experiment login');
const tokenHash = link.properties?.hashed_token ?? link.hashed_token;
if (!tokenHash) throw new Error(`Auth did not return a magic-link token hash (${Object.keys(link).join(',')}; properties=${Object.keys(link.properties ?? {}).join(',')})`);
const session = await responseJson(await fetch(`${projectUrl}/auth/v1/verify`, {
  method: 'POST', headers: { apikey: anonymousKey, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash })
}), 'Verify local experiment login');
const userToken = session.access_token;
if (!userToken) throw new Error('Auth did not return a user access token');

const rest = async (path, init = {}) => responseJson(await fetch(`${projectUrl}/rest/v1/${path}`, {
  ...init,
  headers: { ...serviceHeaders, ...(init.headers ?? {}) }
}), path);
const companies = await rest(`companies?companies_house_number=eq.${encodeURIComponent(companyNumber)}&select=id,legal_name`);
if (companies.length !== 1) throw new Error(`Expected one experiment company, found ${companies.length}`);
const company = companies[0];
const accounts = await rest(`bank_accounts?company_id=eq.${company.id}&xero_account_id=not.is.null&select=id,name,xero_account_id&order=created_at.asc`);
if (accounts.length < (experimentKind === 'transfer' ? 2 : 1)) throw new Error('The experiment does not have enough mapped bank accounts');
const bankAccount = accounts[0];

const functionHeaders = { apikey: anonymousKey, authorization: `Bearer ${userToken}`, 'content-type': 'application/json' };
const options = await responseJson(await fetch(`${projectUrl}/functions/v1/xero-candidate-options`, {
  method: 'POST', headers: functionHeaders, body: JSON.stringify({ companyId: company.id })
}), 'Load Xero candidate options');
const contact = options.contacts?.[0];
const expenseAccount = options.accounts?.find(account => account.class === 'EXPENSE');
if (!contact || !expenseAccount) throw new Error('A Xero contact and expense account are required');

const experimentId = randomUUID();
const amountMinor = experimentKind === 'bank_transaction' ? 137 : experimentKind === 'bill' ? 138 : 139;
const payee = `Workbench recovery experiment · ${experimentKind}${experimentKind === 'transfer' ? ' source' : ''}`;
const unfinishedLines = await rest(`statement_lines?company_id=eq.${company.id}&payee=eq.${encodeURIComponent(payee)}&status=eq.new&active_candidate_set_id=is.null&select=id&order=created_at.desc&limit=1`);
let lineId = unfinishedLines[0]?.id;
let pairedTransferLineId;
if (lineId && experimentKind === 'transfer') {
  const existingMembership = await rest(`candidate_set_lines?statement_line_id=eq.${lineId}&select=candidate_set_id`);
  if (existingMembership.length === 1) {
    const pairedMembership = await rest(`candidate_set_lines?candidate_set_id=eq.${existingMembership[0].candidate_set_id}&statement_line_id=neq.${lineId}&select=statement_line_id`);
    pairedTransferLineId = pairedMembership[0]?.statement_line_id;
  }
  if (!pairedTransferLineId) lineId = undefined;
}
if (!lineId) {
  lineId = randomUUID();
  pairedTransferLineId = experimentKind === 'transfer' ? randomUUID() : undefined;
  const newLines = [{
    id: lineId,
    company_id: company.id,
    bank_account_id: bankAccount.id,
    posted_at: '2026-07-23',
    amount_minor: -amountMinor,
    currency: 'GBP',
    payee,
    description: `Injected ${experimentKind} post-Xero persistence failure ${experimentId.slice(0, 8)}`,
    reference: 'RECOVERY-TEST',
    dedupe_key: `recovery-experiment-${experimentKind}-${experimentId}-source`,
    status: 'new',
    note: 'Synthetic demo-company line for the Xero recovery experiment.'
  }];
  if (pairedTransferLineId) newLines.push({
    id: pairedTransferLineId,
    company_id: company.id,
    bank_account_id: accounts[1].id,
    posted_at: '2026-07-23',
    amount_minor: amountMinor,
    currency: 'GBP',
    payee: `Workbench recovery experiment · ${experimentKind} destination`,
    description: `Injected ${experimentKind} recovery destination ${experimentId.slice(0, 8)}`,
    reference: 'RECOVERY-TEST',
    dedupe_key: `recovery-experiment-${experimentKind}-${experimentId}-destination`,
    status: 'new',
    note: 'Synthetic demo-company line for the Xero recovery experiment.'
  });
  const insertedLines = await rest('statement_lines?select=id,status,active_candidate_set_id', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(newLines)
  });
  if (insertedLines.length !== newLines.length) throw new Error('Could not create the experiment statement line(s)');
}

const prepareBody = {
  companyId: company.id,
  lineId,
  kind: experimentKind,
  pairedTransferLineId,
  candidate: experimentKind === 'transfer' ? {} : { contactId: contact.id, accountCode: expenseAccount.code }
};
const firstResponse = await fetch(`${projectUrl}/functions/v1/xero-prepare-candidate`, {
  method: 'POST',
  headers: { ...functionHeaders, 'x-workbench-failure-point': 'after_xero_write', 'x-workbench-failure-token': faultToken },
  body: JSON.stringify(prepareBody)
});
const first = await firstResponse.json().catch(() => null);
if (firstResponse.status !== 500 || !String(first?.error).includes('Injected failure')) throw new Error(`Failure was not injected at the expected boundary: ${firstResponse.status} ${JSON.stringify(first)}`);

const reservedRows = await rest(`candidate_set_lines?statement_line_id=eq.${lineId}&select=candidate_set_id`);
if (reservedRows.length !== 1) throw new Error(`Expected one reserved candidate, found ${reservedRows.length}`);
const candidateSetId = reservedRows[0].candidate_set_id;
const failedState = (await rest(`candidate_sets?id=eq.${candidateSetId}&select=id,status,preparation_state,correlation_token,xero_write_succeeded_at,recovery_attempts`))[0];
const objectsBeforeRetry = await rest(`xero_objects?candidate_set_id=eq.${candidateSetId}&select=id`);
if (failedState.status !== 'building' || failedState.preparation_state !== 'recovery_needed' || !failedState.xero_write_succeeded_at || objectsBeforeRetry.length !== 0) {
  throw new Error(`Unexpected reserved state after injected failure: ${JSON.stringify({ failedState, objectsBeforeRetry })}`);
}

const secondResponse = await fetch(`${projectUrl}/functions/v1/xero-prepare-candidate`, {
  method: 'POST', headers: functionHeaders, body: JSON.stringify(prepareBody)
});
const second = await responseJson(secondResponse, 'Recover Xero preparation');
if (!second.recovered || second.candidateSetId !== candidateSetId) throw new Error(`Retry did not reattach the reserved Xero object: ${JSON.stringify(second)}`);

const thirdResponse = await fetch(`${projectUrl}/functions/v1/xero-prepare-candidate`, {
  method: 'POST', headers: functionHeaders, body: JSON.stringify(prepareBody)
});
const third = await responseJson(thirdResponse, 'Repeat committed preparation');
if (!third.alreadyCommitted || third.candidateSetId !== candidateSetId) throw new Error(`Committed retry was not idempotent: ${JSON.stringify(third)}`);

const finalCandidate = (await rest(`candidate_sets?id=eq.${candidateSetId}&select=id,status,preparation_state,correlation_token,xero_write_started_at,xero_write_succeeded_at,recovery_attempts,last_preparation_error`))[0];
const finalObjects = await rest(`xero_objects?candidate_set_id=eq.${candidateSetId}&select=object_type,object_role,xero_object_id,xero_status,is_reconciled,correlation_token`);
const expectedLineIds = [lineId, pairedTransferLineId].filter(Boolean);
const finalLines = await rest(`statement_lines?id=in.(${expectedLineIds.join(',')})&select=id,status,active_candidate_set_id,note`);
const expectedObjectCount = experimentKind === 'transfer' ? 3 : 1;
if (finalCandidate.status !== 'active' || finalCandidate.preparation_state !== 'committed' || finalObjects.length !== expectedObjectCount || finalLines.length !== expectedLineIds.length || finalLines.some(line => line.status !== 'prepared' || line.active_candidate_set_id !== candidateSetId)) {
  throw new Error(`Recovery did not commit atomically: ${JSON.stringify({ finalCandidate, finalObjects, finalLines })}`);
}

await fetch(`${projectUrl}/auth/v1/logout?scope=local`, {
  method: 'POST', headers: { apikey: anonymousKey, authorization: `Bearer ${userToken}` }
});

process.stdout.write(JSON.stringify({
  company: company.legal_name,
  kind: experimentKind,
  bankAccounts: accounts.slice(0, experimentKind === 'transfer' ? 2 : 1).map(account => account.name),
  lineIds: expectedLineIds,
  candidateSetId,
  marker: finalCandidate.correlation_token,
  injectedFailure: { httpStatus: firstResponse.status, state: failedState.preparation_state, localXeroObjects: objectsBeforeRetry.length },
  retry: { httpStatus: secondResponse.status, recovered: second.recovered },
  repeatedRetry: { httpStatus: thirdResponse.status, alreadyCommitted: third.alreadyCommitted },
  final: { candidateStatus: finalCandidate.status, preparationState: finalCandidate.preparation_state, recoveryAttempts: finalCandidate.recovery_attempts, lineStatuses: finalLines.map(line => line.status), xeroObjectCount: finalObjects.length, xeroObjectIds: finalObjects.map(object => object.xero_object_id) }
}, null, 2));
