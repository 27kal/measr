import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { DemoRepository } from './infrastructure/demoRepository';

describe('Workbench application', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('routes an incomplete company to Settings and blocks reconciliation', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Fig Tree Studio Ltd/ }));
    expect(await screen.findByRole('heading', { name: 'Finish setup to start reconciling' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeDisabled();
    expect(screen.getByLabelText('Ask Workbench')).toBeInTheDocument();
  });

  it('starts a company chat from the fixed launcher and opens it in Chats', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));

    const launcher = screen.getByLabelText('Ask Workbench');
    await user.type(launcher, 'Which open lines need my attention?{Enter}');

    expect(await screen.findByRole('heading', { name: 'Which open lines need my attention?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chats' })).toHaveClass('active');
    expect((await screen.findAllByText('Which open lines need my attention?')).length).toBeGreaterThan(1);
    expect(await screen.findByText('Company chat uses the connected Workbench agent. Configure Supabase to run it.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask a question or tell Workbench what to remember…')).toBeInTheDocument();
  });

  it('uses the agent recommendation and its conversation instead of a manual accounting form', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /FastPay/ }));
    expect(screen.queryByRole('heading', { name: 'Prepare in Xero' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create candidate in Xero' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Analyse this line' }));
    expect(await screen.findByText('Workbench agent')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Recommendation details' })).toBeInTheDocument();
    const message = await screen.findByLabelText('Message the agent');
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument();
    expect(message.closest('section')).toHaveClass('chat-composer-fixed');
    await user.type(message, 'This was a team lunch');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('This was a team lunch')).toBeInTheDocument());
    expect(screen.getAllByText('Workbench agent').length).toBeGreaterThan(1);
    expect(screen.getByText('Demo agent replied to: “This was a team lunch”')).toBeInTheDocument();
    expect(screen.getByText('Demo-only recommendation; no live model or Xero history was used.')).toBeInTheDocument();
  });

  it('shows a distinct loading state while the saved line conversation is fetched', async () => {
    let resolveThread!: (thread: null) => void;
    const pendingThread = new Promise<null>(resolve => { resolveThread = resolve; });
    vi.spyOn(DemoRepository.prototype, 'getAgentThread').mockReturnValueOnce(pendingThread);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /FastPay/ }));

    expect(await screen.findByRole('heading', { name: 'Loading conversation…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Analyse this line' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message the agent')).toBeDisabled();
    expect(screen.getByLabelText('Upload document')).toBeDisabled();

    await act(async () => resolveThread(null));
    expect(await screen.findByRole('button', { name: 'Analyse this line' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Loading conversation…' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message the agent')).toBeEnabled();
  });

  it('uses one Needs you state after an agent analysis', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /FastPay/ }));
    await user.click(screen.getByRole('button', { name: 'Analyse this line' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /FastPay.*Needs you/ })).toBeInTheDocument());
  });

  it('shows line-action failures as an in-panel error rather than a success toast', async () => {
    vi.spyOn(DemoRepository.prototype, 'runShadowAgent').mockRejectedValueOnce(new Error('Recommendation could not be validated'));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /FastPay/ }));
    await user.click(screen.getByRole('button', { name: 'Analyse this line' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Recommendation could not be validated');
    expect(alert).toHaveClass('panel-notice-error');
    expect(document.querySelector('.toast')).not.toBeInTheDocument();
  });

  it('checks Xero reconciliation before invoking the line agent', async () => {
    vi.spyOn(DemoRepository.prototype, 'preflightXeroReconciliation').mockResolvedValueOnce({
      results: [{ lineId: 'line-fastpay', outcome: 'reconciled', message: 'Matched to Xero' }],
      reconciledLineIds: ['line-fastpay'], ambiguousLineIds: [], unmatchedLineIds: []
    });
    const agent = vi.spyOn(DemoRepository.prototype, 'runShadowAgent');
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /FastPay/ }));
    await user.click(screen.getByRole('button', { name: 'Analyse this line' }));

    expect(await screen.findByText(/Xero already reports this line as reconciled/)).toBeInTheDocument();
    expect(agent).not.toHaveBeenCalled();
  });

  it('uploads requested evidence into the same agent thread', async () => {
    const requestThread = {
      schemaVersion: 1, runId: 'run-request', kind: 'line' as const, model: 'demo', createdAt: new Date().toISOString(),
      input: { statementLine: { id: 'line-fastpay' } }, history: [], responseIds: [],
      finalOutput: { outcome: 'needs_information' as const, proposedOperation: 'request_information' as const, candidateKind: 'none' as const, existingXeroEntityType: 'none' as const, existingXeroEntityId: '', existingXeroEntityNumber: '', existingXeroMatchReason: '', contactId: '', contactName: '', accountCode: '', accountName: '', taxType: '', description: '', reference: '', summary: 'Please upload the invoice.', evidence: [], questions: ['Please provide the invoice.'] }
    };
    vi.spyOn(DemoRepository.prototype, 'runShadowAgent').mockResolvedValueOnce(requestThread);
    const upload = vi.spyOn(DemoRepository.prototype, 'uploadDocument').mockResolvedValueOnce({
      thread: { ...requestThread, runId: 'run-revised', userMessage: 'Uploaded invoice.pdf', document: { id: 'doc-1', filename: 'invoice.pdf', mimeType: 'application/pdf', byteSize: 12, sha256: 'demo' }, finalOutput: { ...requestThread.finalOutput, outcome: 'recommend_candidate', proposedOperation: 'create_new', candidateKind: 'bank_transaction', contactId: 'contact', contactName: 'Supplier', accountCode: '485', accountName: 'Subscriptions', taxType: 'INPUT2', summary: 'Invoice reviewed.' } },
      document: { id: 'doc-1', companyId: 'company-northstar', statementLineId: 'line-fastpay', filename: 'invoice.pdf', mimeType: 'application/pdf', byteSize: 12, sha256: 'demo', analysisStatus: 'analysed', analysisError: null, candidateSetId: null, xeroObjectType: null, xeroObjectId: null, xeroFilename: null, xeroAttachmentId: null, xeroUploadedAt: null, xeroUploadError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /FastPay/ }));
    await user.click(screen.getByRole('button', { name: 'Analyse this line' }));
    expect(await screen.findByRole('heading', { name: 'Document needed' })).toBeInTheDocument();
    expect(screen.getByText('Action needed')).toBeInTheDocument();
    expect(screen.getByText('Workbench agent')).toBeInTheDocument();
    const file = new File(['invoice'], 'invoice.pdf', { type: 'application/pdf' });
    await user.upload(await screen.findByLabelText('Upload document'), file);
    await waitFor(() => expect(upload).toHaveBeenCalledWith(expect.objectContaining({ lineId: 'line-fastpay', runId: 'run-request', file })));
    expect((await screen.findAllByText('Invoice reviewed.')).length).toBeGreaterThan(0);
  });

  it('allows proactive evidence upload when the agent recommends an existing Xero match', async () => {
    const matchThread = {
      schemaVersion: 1, runId: 'run-match', kind: 'line' as const, model: 'demo', createdAt: new Date().toISOString(),
      input: { statementLine: { id: 'line-fastpay' } }, history: [], responseIds: [],
      finalOutput: { outcome: 'recommend_candidate' as const, proposedOperation: 'match_existing' as const, candidateKind: 'bill' as const, existingXeroEntityType: 'invoice' as const, existingXeroEntityId: '02f77624-6930-45c3-8ede-fb4b90d543ef', existingXeroEntityNumber: '0052', existingXeroMatchReason: 'Exact amount', contactId: 'contact', contactName: 'Supplier', accountCode: '', accountName: '', taxType: '', description: '', reference: '', summary: 'Match the existing bill.', evidence: [], questions: [] }
    };
    vi.spyOn(DemoRepository.prototype, 'runShadowAgent').mockResolvedValueOnce(matchThread);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /FastPay/ }));
    await user.click(screen.getByRole('button', { name: 'Analyse this line' }));

    expect(await screen.findByLabelText('Upload document')).toBeInTheDocument();
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();
  });

  it('keeps chat and document upload available after preparation and reconciliation', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));

    await user.click(await screen.findByRole('button', { name: /Transport for London/ }));
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload document')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    await user.click(await screen.findByRole('button', { name: /Square/ }));
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload document')).toBeInTheDocument();
  });

  it('shows a used recommendation only once in the chat thread', async () => {
    const recommendation = { outcome: 'recommend_candidate' as const, proposedOperation: 'create_new' as const, candidateKind: 'bank_transaction' as const, existingXeroEntityType: 'none' as const, existingXeroEntityId: '', existingXeroEntityNumber: '', existingXeroMatchReason: '', contactId: 'contact', contactName: 'Transport for London', accountCode: '493', accountName: 'Travel', taxType: 'NONE', description: 'Contactless travel', reference: '', reply: 'Prepare the travel spend.', summary: 'Prepare the travel spend.', evidence: [], questions: [] };
    const thread = { schemaVersion: 1, runId: 'run-tfl', kind: 'line' as const, model: 'demo', createdAt: new Date().toISOString(), input: {}, history: [], responseIds: [], finalOutput: recommendation, timeline: [{ runId: 'run-tfl', createdAt: new Date().toISOString(), finalOutput: recommendation }] };
    vi.spyOn(DemoRepository.prototype, 'getAgentThread').mockResolvedValue(thread);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Northstar Coffee Roasters Ltd/ }));
    await user.click(await screen.findByRole('button', { name: /Transport for London/ }));

    await waitFor(() => expect(screen.getAllByText('Prepare the travel spend.')).toHaveLength(1));
    expect(screen.getByText('Bank transaction prepared')).toBeInTheDocument();
  });

  it('requires an owner to type the exact legal name before deleting a company', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Fig Tree Studio Ltd/ }));
    await user.click(screen.getByRole('button', { name: 'Delete company' }));

    const confirm = screen.getByRole('button', { name: 'Permanently delete company' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type Fig Tree Studio Ltd to confirm/), 'fig tree studio');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type Fig Tree Studio Ltd to confirm/), ' ltd');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Fig Tree Studio Ltd/ })).not.toBeInTheDocument());
  });
});
