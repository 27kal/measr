import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson } from '../_shared/agent-artifacts.ts';

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const input = await request.json() as { companyId?: string; chatId?: string };
    if (!input.companyId || !input.chatId) return json({ error: 'companyId and chatId are required' }, 422);
    const { service } = await requireCompanyAccess(request, input.companyId);
    const { data: chat, error } = await service.from('company_chats').select('id').eq('company_id', input.companyId).eq('id', input.chatId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!chat) return json({ error: 'Chat not found' }, 404);
    const thread = await readJson(service, artifactPaths.companyChatThread(input.companyId, input.chatId));
    return json({ thread });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('company-chat-thread failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not load the chat' }, 502);
  }
});
