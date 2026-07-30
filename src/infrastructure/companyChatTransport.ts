import { DefaultChatTransport } from 'ai';
import { backendAuthHeaders, backendFunctionUrl } from './supabase';

export function companyChatTransport(companyId: string, chatId: string) {
  return new DefaultChatTransport({
    api: backendFunctionUrl('company-chat'),
    headers: backendAuthHeaders,
    body: { companyId, chatId }
  });
}
