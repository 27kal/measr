import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { ChatBubbleLeftRightIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchRepository } from '../application/repository';
import type { Company, CompanyChat, CompanyChatMessage, CompanyChatThread } from '../domain/types';
import { companyChatTransport } from '../infrastructure/companyChatTransport';
import { runtimeMode } from '../infrastructure/supabase';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from './ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from './ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea
} from './ai-elements/prompt-input';

type Notify = (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;

function formatChatTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date);
}

function toUiMessages(messages: CompanyChatMessage[]): UIMessage[] {
  return messages.map(message => ({ id: message.id, role: message.role, parts: [{ type: 'text', text: message.text }] }));
}

function textParts(message: UIMessage): string[] {
  return message.parts.filter(part => part.type === 'text').map(part => part.text);
}

export function CompanyChatLauncher({ onStart, disabled = false }: { onStart: (message: string) => Promise<void>; disabled?: boolean }) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  return <div className="company-chat-launcher" aria-label="Start a new company chat">
    <PromptInput className="company-chat-prompt company-chat-prompt-compact" onSubmit={async message => {
      const text = message.text.trim();
      if (!text || submitting) return;
      setSubmitting(true); setError('');
      try { await onStart(text); setInput(''); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start the chat'); }
      finally { setSubmitting(false); }
    }}>
      <PromptInputBody>
        <PromptInputTextarea aria-label="Ask Workbench" disabled={disabled || submitting} value={input} onChange={event => setInput(event.currentTarget.value)} placeholder="Ask Workbench about this company…" />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputSubmit disabled={disabled || submitting || !input.trim()} status={submitting ? 'submitted' : 'ready'} />
      </PromptInputFooter>
    </PromptInput>
    {error && <p className="company-chat-launcher-error" role="alert">{error}</p>}
  </div>;
}

function EmptyCompanyChat({ onStart }: { onStart: (message: string) => Promise<void> }) {
  return <div className="company-chat-empty-compose">
    <div><span className="company-chat-empty-icon"><ChatBubbleLeftRightIcon /></span><h2>Start a company chat</h2><p>Ask about statement lines, Xero history, VAT treatment or company bookkeeping memory.</p></div>
    <CompanyChatLauncher onStart={onStart} />
  </div>;
}

function CompanyConversation({
  company, chat, repository, initialMessage, onInitialConsumed, onChanged, notify
}: {
  company: Company; chat: CompanyChat; repository: WorkbenchRepository; initialMessage?: string;
  onInitialConsumed: () => void; onChanged: () => Promise<void>; notify: Notify;
}) {
  const [thread, setThread] = useState<CompanyChatThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const initialSent = useRef(false);
  const transport = useMemo(() => runtimeMode === 'supabase'
    ? companyChatTransport(company.id, chat.id)
    : new DefaultChatTransport({ api: '/demo-company-chat-disabled' }), [chat.id, company.id]);
  const { messages, setMessages, sendMessage, status, error, stop } = useChat({
    id: chat.id,
    transport,
    onFinish: () => { window.setTimeout(() => void onChanged(), 350); },
    onError: reason => notify(reason.message || 'The company agent could not reply', 'error')
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    void repository.getCompanyChatThread(company.id, chat.id).then(result => {
      if (!active) return;
      setThread(result);
      setMessages(toUiMessages(result?.messages ?? []));
    }).catch(reason => notify(reason instanceof Error ? reason.message : 'Could not load the chat', 'error')).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chat.id, chat.latestRunId, company.id, notify, repository, setMessages]);

  useEffect(() => {
    if (!initialMessage || initialSent.current || loading) return;
    initialSent.current = true;
    onInitialConsumed();
    if (runtimeMode === 'demo') {
      const now = new Date().toISOString();
      setMessages([
        { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: initialMessage }] },
        { id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Company chat uses the connected Workbench agent. Configure Supabase to run it.' }] }
      ]);
      setThread({ schemaVersion: 1, kind: 'company_chat', runId: crypto.randomUUID(), model: 'demo', createdAt: now, userMessage: initialMessage, finalOutput: 'Company chat uses the connected Workbench agent. Configure Supabase to run it.', history: [], responseIds: [], messages: [] });
      return;
    }
    void sendMessage({ text: initialMessage });
  }, [initialMessage, loading, onInitialConsumed, sendMessage, setMessages]);

  const submit = async (text: string) => {
    if (runtimeMode === 'demo') {
      setMessages(current => [...current,
        { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] },
        { id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'This local demo does not run the connected company agent.' }] }
      ]);
      return;
    }
    await sendMessage({ text });
  };

  return <section className="company-chat-conversation" aria-label={chat.title}>
    <header><h2>{chat.title}</h2></header>
    <Conversation className="company-chat-scroll">
      <ConversationContent className="company-chat-messages">
        {loading && messages.length === 0 ? <div className="company-chat-loading"><span /><span /><span /></div> : null}
        {!loading && messages.length === 0 ? <ConversationEmptyState icon={<ChatBubbleLeftRightIcon className="size-9" />} title="Ask about this company" description="The agent can inspect Workbench, Xero, HMRC guidance and company memory." /> : null}
        {messages.map(message => <Message from={message.role} key={message.id}>
          <MessageContent>
            {textParts(message).map((text, index) => <MessageResponse key={`${message.id}-${index}`}>{text}</MessageResponse>)}
          </MessageContent>
        </Message>)}
        {(status === 'submitted' || (status === 'streaming' && messages.at(-1)?.role === 'user')) && <div className="company-chat-thinking" aria-label="Workbench is thinking"><span /><span /><span /></div>}
        {error && <div className="company-chat-error" role="alert"><strong>Workbench couldn’t reply</strong><span>{error.message}</span></div>}
      </ConversationContent>
      <ConversationScrollButton className="company-chat-scroll-button" />
    </Conversation>
    <div className="company-chat-composer">
      <PromptInput className="company-chat-prompt" onSubmit={async message => {
        const text = message.text.trim();
        if (!text || status === 'submitted' || status === 'streaming') return;
        setInput('');
        await submit(text);
      }}>
        <PromptInputBody>
          <PromptInputTextarea value={input} onChange={event => setInput(event.currentTarget.value)} placeholder="Ask a question or tell Workbench what to remember…" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputSubmit disabled={!input.trim() && status === 'ready'} status={status} onStop={stop} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  </section>;
}

export function CompanyChats({
  company, chats, selectedChatId, repository, initialMessage, onSelectChat, onNewChat, onStartChat, onInitialConsumed, onChanged, notify
}: {
  company: Company; chats: CompanyChat[]; selectedChatId?: string; repository: WorkbenchRepository; initialMessage?: string;
  onSelectChat: (chatId: string) => void; onNewChat: () => void; onStartChat: (message: string) => Promise<void>;
  onInitialConsumed: () => void; onChanged: () => Promise<void>; notify: Notify;
}) {
  const selected = chats.find(chat => chat.id === selectedChatId) ?? null;
  return <div className="company-chats-layout">
    <aside className="company-chat-list">
      <header><h2>Chats</h2><button className="icon-button" aria-label="New chat" title="New chat" onClick={onNewChat}><PlusIcon className="ui-icon" /></button></header>
      <div>
        {chats.length === 0 && <p className="company-chat-list-empty">Your company chats will appear here.</p>}
        {chats.map(chat => <button className={chat.id === selected?.id ? 'active' : ''} key={chat.id} onClick={() => onSelectChat(chat.id)}>
          <span><strong>{chat.title}</strong>{(chat.running || chat.lastError) && <small>{chat.running ? 'Replying…' : 'Reply failed'}</small>}</span>
          <time>{formatChatTime(chat.updatedAt)}</time>
        </button>)}
      </div>
    </aside>
    <main className="company-chat-main">
      {selected ? <CompanyConversation company={company} chat={selected} repository={repository} initialMessage={initialMessage} onInitialConsumed={onInitialConsumed} onChanged={onChanged} notify={notify} /> : <EmptyCompanyChat onStart={onStartChat} />}
    </main>
  </div>;
}
