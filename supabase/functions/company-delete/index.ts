import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifiedUserId } from '../_shared/auth.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import { disconnectXeroConnection } from '../_shared/xero.ts';

async function deleteAgentArtifacts(service: ReturnType<typeof createClient>, prefix: string): Promise<void> {
  const queue = [prefix];
  const files: string[] = [];
  while (queue.length) {
    const directory = queue.pop()!;
    const { data, error } = await service.storage.from('agent-artifacts').list(directory, { limit: 1000 });
    if (error) throw new Error(`Could not list agent artifacts for deletion: ${error.message}`);
    for (const item of data ?? []) {
      const path = `${directory}/${item.name}`;
      if (item.metadata) files.push(path); else queue.push(path);
    }
  }
  for (let offset = 0; offset < files.length; offset += 100) {
    const { error } = await service.storage.from('agent-artifacts').remove(files.slice(offset, offset + 100));
    if (error) throw new Error(`Could not delete agent artifacts: ${error.message}`);
  }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const userId = verifiedUserId(request);
  if (!userId) return json({ error: 'Invalid or expired session' }, 401);

  try {
    const { companyId, confirmation } = await request.json() as { companyId?: string; confirmation?: string };
    if (!companyId || typeof confirmation !== 'string') return json({ error: 'companyId and confirmation are required' }, 422);

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const [{ data: company }, { data: membership }] = await Promise.all([
      service.from('companies').select('id, legal_name').eq('id', companyId).maybeSingle(),
      service.from('company_memberships').select('role').eq('company_id', companyId).eq('user_id', userId).maybeSingle()
    ]);

    if (!company) return json({ error: 'Company not found' }, 404);
    if (membership?.role !== 'owner') return json({ error: 'Only a company owner can delete this company' }, 403);
    if (confirmation.toLocaleLowerCase('en-GB') !== company.legal_name.toLocaleLowerCase('en-GB')) return json({ error: 'Company name confirmation does not match' }, 422);

    const { data: connection, error: connectionError } = await service
      .from('xero_connections')
      .select('connection_id, disconnected_at')
      .eq('company_id', companyId)
      .maybeSingle();
    if (connectionError) throw connectionError;

    if (connection && !connection.disconnected_at) {
      await disconnectXeroConnection(service, companyId, connection.connection_id);
    }

    await deleteAgentArtifacts(service, companyId);

    const { data: deletedId, error: deleteError } = await service.rpc('delete_company_for_owner', {
      p_company_id: companyId,
      p_user_id: userId,
      p_confirmation: confirmation
    });
    if (deleteError) throw deleteError;
    if (deletedId !== companyId) throw new Error('Company deletion did not complete');

    return json({ deleted: true, companyId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not delete company' }, 500);
  }
});
