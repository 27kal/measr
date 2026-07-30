import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifiedUserId } from '../_shared/auth.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import { DOCUMENT_BUCKET } from '../_shared/documents.ts';

type Service = ReturnType<typeof createClient>;

async function removeFiles(service: Service, keys: string[]): Promise<void> {
  const unique = [...new Set(keys.filter(key => typeof key === 'string' && key.length > 0))];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const { error } = await service.storage.from(DOCUMENT_BUCKET).remove(unique.slice(offset, offset + 100));
    if (error) throw new Error(`Could not delete private files: ${error.message}`);
  }
}

// Agent threads for a line are a folder of run artifacts, not one object.
async function removeThreadArtifacts(service: Service, companyId: string, lineIds: string[]): Promise<void> {
  const files: string[] = [];
  for (const lineId of lineIds) {
    const queue = [`${companyId}/threads/${lineId}`];
    while (queue.length) {
      const directory = queue.pop()!;
      const { data, error } = await service.storage.from(DOCUMENT_BUCKET).list(directory, { limit: 1000 });
      if (error) throw new Error(`Could not list agent artifacts for deletion: ${error.message}`);
      for (const item of data ?? []) {
        const path = `${directory}/${item.name}`;
        if (item.metadata) files.push(path); else queue.push(path);
      }
    }
  }
  await removeFiles(service, files);
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const userId = verifiedUserId(request);
  if (!userId) return json({ error: 'Invalid or expired session' }, 401);

  try {
    const { companyId, importId } = await request.json() as { companyId?: string; importId?: string };
    if (!companyId || !importId) return json({ error: 'companyId and importId are required' }, 422);

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: statementImport, error: lookupError } = await service
      .from('statement_imports')
      .select('id, company_id')
      .eq('id', importId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!statementImport) return json({ error: 'Statement import not found' }, 404);
    if (statementImport.company_id !== companyId) return json({ error: 'Statement does not belong to this company' }, 403);

    // The database transaction is authoritative for both permission and the
    // Xero-entity guard; it returns the private files left to clean up.
    const { data: summary, error: deleteError } = await service.rpc('delete_statement_import', {
      p_import_id: importId,
      p_user_id: userId
    });
    if (deleteError) {
      const status = deleteError.code === '42501' ? 403
        : deleteError.code === 'P0002' ? 404
        : deleteError.code === '23503' ? 409
        : deleteError.code === '55006' ? 409
        : 500;
      return json({ error: deleteError.message }, status);
    }

    const lineIds = ((summary?.lineIds ?? []) as string[]).map(String);
    await removeFiles(service, (summary?.storageKeys ?? []) as string[]);
    await removeThreadArtifacts(service, companyId, lineIds);

    return json({
      deleted: true,
      importId,
      filename: summary?.filename ?? '',
      deletedLines: Number(summary?.deletedLines ?? 0),
      reopenedLines: Number(summary?.reopenedLines ?? 0)
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not delete the statement' }, 500);
  }
});
