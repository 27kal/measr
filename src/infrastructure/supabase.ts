import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const testMode = import.meta.env.MODE === 'test';

export const supabase = !testMode && url && publishableKey ? createClient(url, publishableKey) : null;
export const runtimeMode = supabase ? 'supabase' : 'demo';

export function backendFunctionUrl(functionName: string): string {
  if (!url) throw new Error('Supabase is not configured');
  return `${url}/functions/v1/${functionName}`;
}

export async function backendAuthHeaders(): Promise<Record<string, string>> {
  if (!supabase || !publishableKey) throw new Error('Supabase is not configured');
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error('Your session has expired. Sign in again to continue.');
  return { apikey: publishableKey, Authorization: `Bearer ${data.session.access_token}` };
}

export async function invokeBackend<T>(functionName: string, body: Record<string, unknown>): Promise<T> {
  if (!supabase || !url || !publishableKey) throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) throw new Error('Your session has expired. Sign in again to continue.');
  const response = await fetch(`${url}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${sessionData.session.access_token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as (T & { error?: unknown }) | null;
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Backend request failed (${response.status})`);
  if (!payload) throw new Error('Backend returned an empty response');
  return payload;
}

export async function invokeBackendForm<T>(functionName: string, body: FormData): Promise<T> {
  if (!supabase || !url || !publishableKey) throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) throw new Error('Your session has expired. Sign in again to continue.');
  const response = await fetch(`${url}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: { apikey: publishableKey, Authorization: `Bearer ${sessionData.session.access_token}` },
    body
  });
  const payload = await response.json().catch(() => null) as (T & { error?: unknown }) | null;
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Backend request failed (${response.status})`);
  if (!payload) throw new Error('Backend returned an empty response');
  return payload;
}
