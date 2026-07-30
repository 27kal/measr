import { createAiSdkUiMessageStreamResponse } from 'npm:@openai/agents-extensions@0.14.1/ai-sdk-ui';
import 'npm:ai@7.0.42';
import { corsHeaders, json } from '../_shared/http.ts';
import { requireCompanyAccess } from '../_shared/company-access.ts';
import { artifactPaths, readJson, writeThreadArtifact } from '../_shared/agent-artifacts.ts';
import { startCompanyChatAgentStream } from '../_shared/agent-runtime.ts';

type Row = Record<string, any>;

function latestUserText(input: Record<string, any>): string {
  if (typeof input.message === 'string') return input.message.trim();
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const latest = [...messages].reverse().find(message => message?.role === 'user');
  if (!latest) return '';
  if (typeof latest.content === 'string') return latest.content.trim();
  return (Array.isArray(latest.parts) ? latest.parts : [])
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
    .trim();
}

function keepAlive(task: Promise<unknown>) {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
  else void task;
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  let reservation: { service: any; companyId: string; chatId: string; runId: string } | null = null;
  try {
    const input = await request.json() as Record<string, any>;
    const companyId = typeof input.companyId === 'string' ? input.companyId : '';
    const chatId = typeof input.chatId === 'string' ? input.chatId : '';
    const message = latestUserText(input);
    if (!companyId || !chatId || !message) return json({ error: 'companyId, chatId and a user message are required' }, 422);
    if (message.length > 8_000) return json({ error: 'Message must be 8,000 characters or fewer' }, 422);

    const { service } = await requireCompanyAccess(request, companyId);
    const { data: chat, error: chatError } = await service.from('company_chats').select('id,latest_run_id').eq('company_id', companyId).eq('id', chatId).maybeSingle();
    if (chatError) throw new Error(chatError.message);
    if (!chat) return json({ error: 'Chat not found' }, 404);

    const { data: runId, error: reserveError } = await service.rpc('reserve_company_chat_run', { p_company_id: companyId, p_chat_id: chatId });
    if (reserveError || !runId) {
      const message = reserveError?.message ?? 'Could not reserve the chat';
      return json({ error: /already replying/i.test(message) ? 'This chat is already replying' : message }, /already replying/i.test(message) ? 409 : 502);
    }
    reservation = { service, companyId, chatId, runId: String(runId) };

    const previous = await readJson<Row>(service, artifactPaths.companyChatThread(companyId, chatId));
    if (chat.latest_run_id && (!previous || previous.runId !== chat.latest_run_id)) throw new Error('The chat index and saved conversation are out of sync');
    const stream = await startCompanyChatAgentStream(service, companyId, previous, message);
    const createdAt = new Date().toISOString();
    const persistence = (async () => {
      try {
        await stream.completed;
        if (stream.error) throw stream.error;
        const finalOutput = String(stream.finalOutput ?? '').trim();
        if (!finalOutput) throw new Error('The company agent returned an empty response');
        const messages = [
          ...(Array.isArray(previous?.messages) ? previous.messages : []),
          { id: crypto.randomUUID(), role: 'user', text: message, createdAt },
          { id: crypto.randomUUID(), role: 'assistant', text: finalOutput, createdAt: new Date().toISOString() }
        ];
        const artifact = {
          schemaVersion: 1,
          kind: 'company_chat',
          runId: String(runId),
          ...(previous?.runId ? { parentRunId: String(previous.runId) } : {}),
          model: Deno.env.get('OPENAI_AGENT_MODEL') ?? 'gpt-5.6',
          createdAt,
          userMessage: message,
          finalOutput,
          history: stream.history,
          responseIds: stream.rawResponses.map((response: { responseId?: string }) => response.responseId).filter(Boolean),
          messages
        };
        await writeThreadArtifact(service, artifactPaths.companyChatThread(companyId, chatId), artifact);
        const { error } = await service.rpc('finish_company_chat_run', { p_company_id: companyId, p_chat_id: chatId, p_run_id: runId });
        if (error) throw new Error(error.message);
      } catch (error) {
        console.error('company chat persistence failed', error);
        await service.rpc('fail_company_chat_run', {
          p_company_id: companyId,
          p_chat_id: chatId,
          p_run_id: runId,
          p_error: error instanceof Error ? error.message : 'Company chat failed'
        });
      }
    })();
    keepAlive(persistence);
    return createAiSdkUiMessageStreamResponse(stream, { headers: corsHeaders });
  } catch (error) {
    if (reservation) {
      await reservation.service.rpc('fail_company_chat_run', {
        p_company_id: reservation.companyId,
        p_chat_id: reservation.chatId,
        p_run_id: reservation.runId,
        p_error: error instanceof Error ? error.message : 'Company chat failed'
      });
    }
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    console.error('company-chat failed', error);
    return json({ error: error instanceof Error ? error.message : 'Could not continue the company chat' }, 502);
  }
});
