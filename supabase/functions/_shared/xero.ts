export type XeroEntity = 'bank_transaction' | 'bill' | 'invoice' | 'transfer';

export class XeroRateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number) {
    super(message);
    this.name = 'XeroRateLimitError';
  }
}

export function correlationToken(lineId: string, attempt: number): string {
  return `WB-${lineId.replaceAll('-', '').slice(0, 20).toUpperCase()}-A${attempt}`;
}

export function authorisedInvoicePayload(input: { kind: 'bill' | 'invoice'; contactId: string; accountCode: string; taxType?: string; amount: number; invoiceNumber?: string; reference: string; description: string; date: string; dueDate: string }) {
  return {
    Type: input.kind === 'bill' ? 'ACCPAY' : 'ACCREC',
    Contact: { ContactID: input.contactId },
    Status: 'AUTHORISED',
    Date: input.date,
    DueDate: input.dueDate,
    ...(input.invoiceNumber ? { InvoiceNumber: input.invoiceNumber } : {}),
    Reference: input.reference,
    LineAmountTypes: 'Inclusive',
    LineItems: [{ Description: input.description, Quantity: 1, UnitAmount: input.amount, AccountCode: input.accountCode, ...(input.taxType ? { TaxType: input.taxType } : {}) }]
  };
}

export async function xeroRequest(token: string, tenantId: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId, accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
  const responseText = await response.text();
  let payload: any;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`Xero ${path} returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    const responseElements = Object.values(payload ?? {}).flatMap(value => Array.isArray(value) ? value : []);
    const validationMessage = [
      ...(Array.isArray(payload?.Elements) ? payload.Elements : []),
      ...responseElements
    ].flatMap((element: { ValidationErrors?: Array<{ Message?: string }> }) => element?.ValidationErrors ?? [])[0]?.Message;
    const diagnostic = validationMessage ?? payload?.Message ?? JSON.stringify(payload).slice(0, 1000) ?? 'Unknown Xero error';
    const rateLimit = response.status === 429
      ? [
          ['retry-after', response.headers.get('retry-after')],
          ['problem', response.headers.get('x-rate-limit-problem')],
          ['minute-remaining', response.headers.get('x-minlimit-remaining')],
          ['day-remaining', response.headers.get('x-daylimit-remaining')]
        ].filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`).join(', ')
      : '';
    const message = `Xero ${path} failed (${response.status}): ${diagnostic}${rateLimit ? ` [${rateLimit}]` : ''}`;
    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      throw new XeroRateLimitError(message, Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 300);
    }
    throw new Error(message);
  }
  return payload;
}

export async function freshXeroAccessToken(service: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }, companyId: string): Promise<string> {
  const refreshResult = await service.rpc('xero_refresh_token_for_worker', { target_company_id: companyId });
  if (refreshResult.error || typeof refreshResult.data !== 'string') throw new Error(refreshResult.error?.message ?? 'Xero refresh token is unavailable');
  const clientId = Deno.env.get('XERO_CLIENT_ID');
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Xero OAuth credentials are not configured');
  const response = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshResult.data })
  });
  const tokenText = await response.text();
  let tokens: { access_token?: string; refresh_token?: string; error?: string };
  try { tokens = tokenText ? JSON.parse(tokenText) : {}; }
  catch { throw new Error(`Xero token refresh returned invalid JSON (${response.status})`); }
  if (!response.ok || !tokens.access_token || !tokens.refresh_token) throw new Error(`Xero token refresh failed: ${tokens.error ?? response.status}`);
  const rotateResult = await service.rpc('rotate_xero_refresh_token_for_worker', { target_company_id: companyId, new_refresh_token: tokens.refresh_token });
  if (rotateResult.error) throw new Error(`Could not rotate Xero refresh token: ${rotateResult.error.message}`);
  return tokens.access_token;
}

async function appConnectionsAccessToken(): Promise<string> {
  const clientId = Deno.env.get('XERO_CLIENT_ID');
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Xero OAuth credentials are not configured');
  const response = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'app.connections' })
  });
  const payload = await response.json() as { access_token?: string; error?: string };
  if (!response.ok || !payload.access_token) throw new Error(`Xero connection-management token failed: ${payload.error ?? response.status}`);
  return payload.access_token;
}

async function deleteXeroConnection(accessToken: string, connectionId: string): Promise<Response> {
  return fetch(`https://api.xero.com/connections/${connectionId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
  });
}

export async function disconnectXeroConnection(
  service: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  companyId: string,
  connectionId: string
): Promise<void> {
  let response: Response | null = null;
  try {
    response = await deleteXeroConnection(await freshXeroAccessToken(service, companyId), connectionId);
  } catch {
    // A stale or revoked refresh token must not strand an undeletable company.
    // Xero's app.connections grant can still remove this one known connection.
  }

  if (!response || response.status === 401 || response.status === 403) {
    response = await deleteXeroConnection(await appConnectionsAccessToken(), connectionId);
  }

  if (response.status === 204 || response.status === 404) return;
  const detail = (await response.text()).slice(0, 500);
  throw new Error(`Could not disconnect the Xero organisation (${response.status})${detail ? `: ${detail}` : ''}`);
}
