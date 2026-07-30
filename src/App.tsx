import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  BanknotesIcon,
  BeakerIcon,
  BuildingLibraryIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  DocumentIcon,
  EllipsisHorizontalCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RectangleGroupIcon,
  ShieldCheckIcon,
  TrashIcon,
  XCircleIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';
import type { StatementImportDeletionResult, WorkbenchSnapshot } from './application/repository';
import { candidateSetsForObservation } from './application/observation';
import { DemoRepository } from './infrastructure/demoRepository';
import { runtimeMode, supabase } from './infrastructure/supabase';
import { SupabaseRepository } from './infrastructure/supabaseRepository';
import { isOperational, readinessChecks } from './domain/readiness';
import { planStatementImportDeletion } from './domain/statementImportDeletion';
import type { AgentRecommendation, AgentThread, AgentTimelineRun, BankAccount, CompaniesHouseResult, Company, LineDocument, StatementImport, StatementLine, StatementLineStatus, WorkflowState, XeroAttachmentInfo, XeroCandidateOptions, XeroObservationProgress } from './domain/types';
import { hasXeroAttachmentScope, isXeroAttachmentPermissionError, xeroAttachmentErrorMessage } from './application/xeroAttachments';
import { CompanyChatLauncher, CompanyChats } from './components/CompanyChats';

const repository = runtimeMode === 'supabase' ? new SupabaseRepository() : new DemoRepository();
type CompanyTab = 'feed' | 'chats' | 'settings';
type Page = { kind: 'home' } | { kind: 'company'; companyId: string; tab: CompanyTab; chatId?: string };
type NoticeTone = 'success' | 'error' | 'warning' | 'info';
type Notice = { message: string; tone: NoticeTone };
type Notify = (message: string, tone?: NoticeTone) => void;

const xeroLinkCache = new Map<string, { expiresAt: number; promise: Promise<string> }>();

function prepareXeroLink(companyId: string): Promise<string> {
  const cached = xeroLinkCache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = repository.startXeroConnection(companyId).catch(error => {
    xeroLinkCache.delete(companyId);
    throw error;
  });
  // OAuth state expires after ten minutes; refresh the cached link before then.
  xeroLinkCache.set(companyId, { expiresAt: Date.now() + 8 * 60_000, promise });
  return promise;
}

const statusMeta: Record<StatementLineStatus, { label: string; tone: string }> = {
  new: { label: 'New', tone: 'slate' }, processing: { label: 'Processing', tone: 'blue' }, needs_you: { label: 'Needs you', tone: 'amber' },
  waiting_doc: { label: 'Needs you', tone: 'amber' }, prepared: { label: 'Prepared', tone: 'cyan' }, reconciled: { label: 'Reconciled', tone: 'green' }
};

function NoticeIcon({ tone }: { tone: NoticeTone }) {
  if (tone === 'success') return <CheckCircleIcon className="ui-icon notice-icon"/>;
  if (tone === 'error') return <XCircleIcon className="ui-icon notice-icon"/>;
  if (tone === 'warning') return <ExclamationTriangleIcon className="ui-icon notice-icon"/>;
  return <InformationCircleIcon className="ui-icon notice-icon"/>;
}

function formatMoney(amountMinor: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Math.abs(amountMinor) / 100);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (/429|rate.?limit/i.test(message)) return 'Xero is temporarily limiting requests. Workbench will try again automatically.';
  if (/unexpected end of json|file:\/\/|\bat\s+async\b|ext:runtime|sb-compile/i.test(message) || message.length > 180) return fallback;
  return message || fallback;
}

function xeroObservationStatus(observation?: XeroObservationProgress): string {
  if (observation?.status === 'syncing') return 'Checking the Xero ledger now…';
  if (observation?.status === 'retrying') return 'Ledger check delayed by Xero · retry scheduled automatically';
  if (observation?.lastError) return /429|rate.?limit/i.test(observation.lastError)
    ? 'Last ledger check was rate limited · retry scheduled automatically'
    : 'Last ledger check did not finish';
  if (observation?.lastSucceededAt) return `Last ledger check ${formatDateTime(observation.lastSucceededAt)} · ${observation.changedLineCount ? `${observation.changedLineCount} line${observation.changedLineCount === 1 ? '' : 's'} updated` : 'no changes'}`;
  return 'No ledger check has completed yet';
}

function taxTypeLabel(taxType: string): string {
  const labels: Record<string, string> = {
    NONE: 'No VAT', INPUT2: '20% VAT on expenses', OUTPUT2: '20% VAT on income',
    EXEMPTINPUT: 'VAT exempt expense', EXEMPTOUTPUT: 'VAT exempt income', ZERORATEDINPUT: 'Zero-rated expense', ZERORATEDOUTPUT: 'Zero-rated income'
  };
  return taxType ? labels[taxType] ? `${labels[taxType]} · ${taxType}` : taxType : 'Not resolved';
}

function StatusPill({ status }: { status: StatementLineStatus }) {
  const meta = statusMeta[status];
  return <span className={`pill pill-${meta.tone}`}><span className="pill-dot" />{meta.label}</span>;
}

function WorkbenchApp() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [page, setPage] = useState<Page>({ kind: 'home' });
  const [addingCompany, setAddingCompany] = useState(false);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [pendingChat, setPendingChat] = useState<{ chatId: string; message: string } | null>(null);
  const [toast, setToast] = useState<Notice | null>(null);
  const notify: Notify = useCallback((message, tone = 'success') => setToast({ message, tone }), []);

  const reload = useCallback(async () => setSnapshot(await repository.load()), []);
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const xero = parameters.get('xero');
    const companyId = parameters.get('company');
    if (xero === 'connected') setToast({ message: 'Xero organisation connected', tone: 'success' });
    if (xero === 'error') setToast({ message: `Xero connection failed: ${parameters.get('detail') ?? 'unknown error'}`, tone: 'error' });
    if (xero && companyId) setPage({ kind: 'company', companyId, tab: 'settings' });
    if (xero) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  if (!snapshot) return <div className="loading-screen"><div className="brand-mark">W</div><p>Opening Workbench…</p></div>;

  const openCompany = (company: Company) => {
    setPage({ kind: 'company', companyId: company.id, tab: isOperational(company.setup) ? 'feed' : 'settings' });
    setSelectedLineId(null);
  };
  const activeCompany = page.kind === 'company' ? snapshot.companies.find(company => company.id === page.companyId) : null;
  const selectedLine = selectedLineId ? snapshot.workflow.lines.find(line => line.id === selectedLineId) ?? null : null;
  const startCompanyChat = async (company: Company, message: string) => {
    const chat = await repository.createCompanyChat(company.id, message);
    setPendingChat({ chatId: chat.id, message });
    await reload();
    setPage({ kind: 'company', companyId: company.id, tab: 'chats', chatId: chat.id });
    setSelectedLineId(null);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setPage({ kind: 'home' })}><span className="brand-mark">W</span><span>Workbench</span></button>
        <nav className="primary-nav">
          <button className={page.kind === 'home' ? 'active' : ''} onClick={() => setPage({ kind: 'home' })}>
            <RectangleGroupIcon className="ui-icon"/>Companies
          </button>
        </nav>
        <div className="sidebar-companies">
          <p>Your companies</p>
          {snapshot.companies.map(company => (
            <button key={company.id} className={activeCompany?.id === company.id ? 'active' : ''} onClick={() => openCompany(company)}>
              <span className="company-avatar">{company.legalName.slice(0, 1)}</span><span>{company.legalName.replace(/ Ltd$/i, '')}</span>
            </button>
          ))}
        </div>
        {runtimeMode === 'demo' && <div className="sidebar-footer">
          <div className="mode-row"><span className="mode-dot demo" />Local demo data</div>
          <button onClick={async () => { await repository.resetDemo(); await reload(); setPage({ kind: 'home' }); notify('Demo data restored'); }}>Reset demo</button>
        </div>}
      </aside>

      <main className="main">
        {page.kind === 'home' ? (
          <Home companies={snapshot.companies} workflow={snapshot.workflow} onOpen={openCompany} onAdd={() => setAddingCompany(true)} />
        ) : activeCompany ? (
          <CompanyView
            company={activeCompany}
            tab={page.tab}
            snapshot={snapshot}
            selectedLine={selectedLine}
            selectedChatId={page.chatId}
            pendingChat={pendingChat}
            onTab={(tab, chatId) => setPage({ kind: 'company', companyId: activeCompany.id, tab, ...(chatId ? { chatId } : {}) })}
            onStartChat={message => startCompanyChat(activeCompany, message)}
            onChatConsumed={() => setPendingChat(null)}
            onSelectLine={line => setSelectedLineId(line.id)}
            onCloseLine={() => setSelectedLineId(null)}
            onChanged={reload}
            onDeleted={async () => { xeroLinkCache.delete(activeCompany.id); setSelectedLineId(null); setPage({ kind: 'home' }); await reload(); notify(`${activeCompany.legalName} deleted`); }}
            notify={notify}
          />
        ) : null}
      </main>

      {addingCompany && <AddCompany onClose={() => setAddingCompany(false)} onCreated={async company => { await reload(); setAddingCompany(false); setPage({ kind: 'company', companyId: company.id, tab: 'settings' }); if (runtimeMode === 'supabase' && !company.setup.xeroConnected) void prepareXeroLink(company.id).catch(() => undefined); notify(`${company.legalName} created`); }} />}
      {toast && <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
        <NoticeIcon tone={toast.tone}/>{toast.message}
      </div>}
    </div>
  );
}

function Home({ companies, workflow, onOpen, onAdd }: { companies: Company[]; workflow: WorkbenchSnapshot['workflow']; onOpen: (company: Company) => void; onAdd: () => void }) {
  const needsAttention = workflow.lines.filter(line => line.status === 'needs_you' || line.status === 'waiting_doc').length;
  return <div className="page home-page">
    <header className="page-header"><div><p className="eyebrow">Portfolio</p><h1>Your companies</h1><p>See what needs attention across your portfolio.</p></div><button className="button primary" onClick={onAdd}><PlusIcon className="ui-icon"/>Add company</button></header>
    <section className="portfolio-strip">
      <div><strong>{companies.length}</strong><span>Companies</span></div><div><strong>{needsAttention}</strong><span>Need attention</span></div><div><strong>{workflow.lines.filter(line => line.status === 'prepared').length}</strong><span>Prepared</span></div><div><strong>{workflow.lines.filter(line => line.status === 'reconciled').length}</strong><span>Reconciled</span></div>
    </section>
    <div className="company-grid company-grid-home" aria-label="Companies">
      {companies.map(company => {
        const checks = readinessChecks(company.setup);
        const missing = checks.filter(check => check.blocking && !check.complete).length;
        const companyLines = workflow.lines.filter(line => line.companyId === company.id);
        return <button className="company-card" key={company.id} onClick={() => onOpen(company)}>
          <div className="company-card-top"><span className="company-avatar large">{company.legalName.slice(0, 1)}</span>{missing > 0 && <span className="setup-badge incomplete">{missing} setup steps</span>}</div>
          <h3>{company.legalName}</h3><p>{company.companiesHouseNumber} · United Kingdom</p>
          <div className="company-card-stats"><span><strong>{companyLines.filter(line => line.status === 'needs_you' || line.status === 'waiting_doc').length}</strong> need attention</span><span><strong>{companyLines.length}</strong> bank lines</span></div>
          <div className="card-link">Open company <ChevronRightIcon className="ui-icon ui-icon-sm"/></div>
        </button>;
      })}
      <button className="company-card add-card" onClick={onAdd}><span className="add-circle"><PlusIcon className="ui-icon ui-icon-lg"/></span><h3>Add a UK company</h3><p>Search Companies House to get started.</p></button>
    </div>
  </div>;
}

function CompanyView({ company, tab, snapshot, selectedLine, selectedChatId, pendingChat, onTab, onStartChat, onChatConsumed, onSelectLine, onCloseLine, onChanged, onDeleted, notify }: {
  company: Company; tab: CompanyTab; snapshot: WorkbenchSnapshot; selectedLine: StatementLine | null; selectedChatId?: string;
  pendingChat: { chatId: string; message: string } | null; onTab: (tab: CompanyTab, chatId?: string) => void;
  onStartChat: (message: string) => Promise<void>; onChatConsumed: () => void;
  onSelectLine: (line: StatementLine) => void; onCloseLine: () => void; onChanged: () => Promise<void>; onDeleted: () => Promise<void>; notify: Notify;
}) {
  const companyLines = snapshot.workflow.lines.filter(line => line.companyId === company.id);
  const companyChats = snapshot.companyChats.filter(chat => chat.companyId === company.id);
  const ready = isOperational(company.setup);
  const analysisBatches = snapshot.analysisBatches.filter(batch => batch.companyId === company.id);
  const analysisActive = analysisBatches.some(batch => ['queued', 'snapshotting', 'running'].includes(batch.status));
  const statementImports = snapshot.statementImports.filter(statementImport => statementImport.companyId === company.id);
  const statementImportActive = statementImports.some(statementImport => ['queued', 'processing', 'retryable'].includes(statementImport.status));
  const xeroObservation = snapshot.xeroObservations.find(observation => observation.companyId === company.id);
  const observationActive = xeroObservation?.status === 'syncing' || xeroObservation?.status === 'retrying';
  useEffect(() => {
    if (runtimeMode !== 'supabase' || (!ready && !statementImportActive)) return;
    const timer = window.setInterval(() => void onChanged(), analysisActive || observationActive || statementImportActive ? 2500 : 30_000);
    return () => window.clearInterval(timer);
  }, [analysisActive, observationActive, statementImportActive, onChanged, ready]);
  return <div className={`page company-page ${tab !== 'chats' ? 'company-page-with-chat-launcher' : ''}`}>
    <header className="company-header"><div className="company-title"><span className="company-avatar large">{company.legalName.slice(0, 1)}</span><div><p className="eyebrow">{company.companiesHouseNumber}</p><h1>{company.legalName}</h1></div></div></header>
    <nav className="tab-nav"><button className={tab === 'feed' ? 'active' : ''} disabled={!ready} onClick={() => onTab('feed')}>Reconcile{companyLines.filter(line => line.status === 'needs_you' || line.status === 'waiting_doc').length > 0 && <span>{companyLines.filter(line => line.status === 'needs_you' || line.status === 'waiting_doc').length}</span>}</button><button className={tab === 'chats' ? 'active' : ''} onClick={() => onTab('chats', selectedChatId ?? companyChats[0]?.id)}>Chats</button><button className={tab === 'settings' ? 'active' : ''} onClick={() => onTab('settings')}>Settings</button></nav>
    {tab === 'feed' && ready ? <Feed company={company} lines={companyLines} workflow={snapshot.workflow} analysisBatches={analysisBatches} statementImports={statementImports} xeroObservation={xeroObservation} onSelect={onSelectLine} notify={notify} onChanged={onChanged} /> : tab === 'chats' ? <CompanyChats company={company} chats={companyChats} selectedChatId={selectedChatId} repository={repository} initialMessage={pendingChat && pendingChat.chatId === selectedChatId ? pendingChat.message : undefined} onSelectChat={chatId => onTab('chats', chatId)} onNewChat={() => onTab('chats')} onStartChat={onStartChat} onInitialConsumed={onChatConsumed} onChanged={onChanged} notify={notify} /> : <Settings company={company} statementImports={statementImports} workflow={snapshot.workflow} xeroObservation={xeroObservation} onChanged={onChanged} onDeleted={onDeleted} notify={notify} />}
    {tab !== 'chats' && !selectedLine && <CompanyChatLauncher onStart={onStartChat} />}
    {selectedLine && <LinePanel line={selectedLine} company={company} workflow={snapshot.workflow} documents={snapshot.documents.filter(document => document.statementLineId === selectedLine.id)} onClose={onCloseLine} onChanged={onChanged} notify={notify} />}
  </div>;
}

function Feed({ company, lines, workflow, analysisBatches, statementImports, xeroObservation, onSelect, notify, onChanged }: { company: Company; lines: StatementLine[]; workflow: WorkbenchSnapshot['workflow']; analysisBatches: WorkbenchSnapshot['analysisBatches']; statementImports: StatementImport[]; xeroObservation?: XeroObservationProgress; onSelect: (line: StatementLine) => void; notify: Notify; onChanged: () => Promise<void> }) {
  const [filter, setFilter] = useState<'all' | 'needs_you' | 'prepared' | 'reconciled'>('all');
  const [bankId, setBankId] = useState(company.lastOpenedBankAccountId ?? company.bankAccounts[0]?.id ?? '');
  const [schedulingSync, setSchedulingSync] = useState(false);
  const [uploadingStatement, setUploadingStatement] = useState(false);
  const [statementError, setStatementError] = useState('');
  const [confirmingImportId, setConfirmingImportId] = useState<string | null>(null);
  const [statementResult, setStatementResult] = useState<{ filename: string; imported: number; duplicates: number } | null>(null);
  const bankLines = lines.filter(line => line.bankAccountId === bankId);
  const matchesFilter = (line: StatementLine, selected: typeof filter) => selected === 'all' || (selected === 'needs_you' ? line.status === 'needs_you' || line.status === 'waiting_doc' : line.status === selected);
  const visible = bankLines.filter(line => matchesFilter(line, filter));
  const observableSets = candidateSetsForObservation(workflow.candidateSets, workflow.lines, company.id, bankId, runtimeMode === 'supabase');
  const relevantBatch = (batch: WorkbenchSnapshot['analysisBatches'][number]) => (!batch.bankAccountId || batch.bankAccountId === bankId) && ['queued', 'snapshotting', 'running'].includes(batch.status);
  const currentBatch = analysisBatches.find(relevantBatch);
  const activeLineIds = new Set(analysisBatches.filter(relevantBatch).flatMap(batch => batch.activeLineIds));
  const currentStatementImport = statementImports.filter(statementImport => statementImport.bankAccountId === bankId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).find(statementImport => statementImport.status !== 'complete') ?? null;
  const activitySyncAt = useRef(0);
  const queueActivitySync = useCallback(async (force = false) => {
    if (runtimeMode !== 'supabase' || company.memberRole === 'viewer' || currentBatch || currentStatementImport || xeroObservation?.status === 'syncing' || xeroObservation?.status === 'retrying') return;
    if (!force && Date.now() - activitySyncAt.current < 60_000) return;
    activitySyncAt.current = Date.now();
    try {
      await repository.enqueueXeroObservation(company.id);
      await onChanged();
    } catch {
      // Activity-triggered synchronization is best effort. Explicit refresh
      // reports failures in context and remains available to the user.
    }
  }, [company.id, company.memberRole, currentBatch, currentStatementImport, onChanged, xeroObservation?.status]);
  useEffect(() => {
    void queueActivitySync();
    const onFocus = () => {
      if (sessionStorage.getItem('workbench-xero-return-company') !== company.id) return;
      sessionStorage.removeItem('workbench-xero-return-company');
      void queueActivitySync(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [company.id, queueActivitySync]);
  useEffect(() => setStatementResult(null), [bankId]);
  const uploadStatement = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    setUploadingStatement(true); setStatementError(''); setStatementResult(null);
    try {
      for (const file of files) {
        const uploaded = await repository.uploadStatement(company.id, bankId, file);
        if (uploaded.status === 'complete') setStatementResult({ filename: uploaded.filename, imported: uploaded.importedCount, duplicates: uploaded.duplicateCount });
      }
      await onChanged();
    }
    catch (error) { setStatementError(friendlyError(error, 'Could not upload the statement')); }
    finally { setUploadingStatement(false); event.target.value = ''; }
  };
  const confirmStatement = async (statementImport: StatementImport) => {
    setConfirmingImportId(statementImport.id); setStatementError('');
    try {
      const result = await repository.confirmStatementImport(company.id, statementImport.id);
      setStatementResult({ filename: statementImport.filename, imported: result.imported, duplicates: result.duplicates });
      await onChanged();
    }
    catch (error) { setStatementError(friendlyError(error, 'Could not import the statement')); }
    finally { setConfirmingImportId(null); }
  };
  const syncFromXero = async () => {
    try {
      if (runtimeMode === 'supabase') {
        setSchedulingSync(true);
        await repository.enqueueXeroObservation(company.id);
        await onChanged();
        notify('Xero check scheduled', 'info');
        return;
      }
      const unlinked = bankLines.filter(line => !line.activeCandidateSetId && line.status !== 'prepared' && line.status !== 'reconciled');
      const preflight = { reconciledLineIds: [], ambiguousLineIds: [], unmatchedLineIds: [], results: [] };
      for (const set of observableSets) {
        if (set.kind === 'transfer') await repository.observe(set.id, { objectStatus: 'AUTHORISED', fromIsReconciled: true, toIsReconciled: true, fromFingerprintMatches: true, toFingerprintMatches: true });
        else if (set.kind === 'bill' || set.kind === 'invoice') {
          const member = set.lines[0];
          await repository.observe(set.id, { parentStatus: 'PAID', payment: { xeroObjectId: `demo-payment-${set.id}`, status: 'AUTHORISED', isReconciled: true, amountMinor: Math.abs(member.expectedAmountMinor), bankAccountId: member.expectedBankAccountId } });
        } else await repository.observe(set.id, { objectStatus: 'AUTHORISED', isReconciled: true, fingerprintMatches: true });
      }
      await onChanged();
      const checked = observableSets.length + unlinked.length;
      const summary = preflight.reconciledLineIds.length || preflight.ambiguousLineIds.length
        ? `Checked ${checked} lines · ${preflight.reconciledLineIds.length} existing reconciliations linked · ${preflight.ambiguousLineIds.length} ambiguous`
        : checked ? `Checked ${checked} bank lines · no new reconciliations found` : 'No Xero records or unmatched lines to check';
      notify(summary, preflight.ambiguousLineIds.length ? 'warning' : 'info');
    } catch (error) {
      notify(friendlyError(error, 'Could not check Xero. Try again.'), 'error');
    } finally { setSchedulingSync(false); }
  };
  const filters: Array<{ key: typeof filter; label: string }> = [{ key: 'all', label: 'All lines' }, { key: 'needs_you', label: 'Needs you' }, { key: 'prepared', label: 'Prepared' }, { key: 'reconciled', label: 'Reconciled' }];
  return <div className="content feed-content">
    <div className="content-toolbar"><div className="bank-account-control"><label htmlFor="bank-account">Bank account</label><select id="bank-account" value={bankId} onChange={event => { setBankId(event.target.value); setStatementError(''); }}>{company.bankAccounts.map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></div><div className="feed-toolbar-actions"><label className={`button secondary upload-button ${uploadingStatement ? 'disabled' : ''}`}><ArrowUpTrayIcon className="ui-icon"/>{uploadingStatement ? 'Uploading…' : 'Upload statement'}<input type="file" multiple disabled={uploadingStatement} accept=".csv,.tsv,.xls,.xlsx,.pdf,text/csv,text/tab-separated-values,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => void uploadStatement(event)}/></label><button className="button xero-check-button" disabled={schedulingSync || xeroObservation?.status === 'syncing' || xeroObservation?.status === 'retrying'} onClick={syncFromXero}><ArrowPathIcon className="ui-icon ui-icon-sm"/>{runtimeMode === 'demo' ? 'Refresh from Xero' : xeroObservation?.status === 'retrying' ? 'Retry scheduled' : schedulingSync || xeroObservation?.status === 'syncing' ? 'Checking Xero…' : 'Check Xero'}</button></div></div>
    {statementError && <div className="panel-notice panel-notice-error" role="alert"><NoticeIcon tone="error"/><span>{statementError}</span></div>}
    {currentStatementImport && <div className={`feed-statement-import feed-statement-${currentStatementImport.status}`} role="status"><div>{['queued', 'processing', 'retryable'].includes(currentStatementImport.status) && <span className="analysis-spinner"/>}<p><strong>{currentStatementImport.status === 'awaiting_confirmation' ? 'Statement ready to import' : currentStatementImport.status === 'failed' ? 'Statement was not imported' : 'Reading and verifying statement'}</strong><span>{currentStatementImport.filename}{currentStatementImport.status === 'awaiting_confirmation' ? ` · ${currentStatementImport.transactionCount} transactions${currentStatementImport.periodStart && currentStatementImport.periodEnd ? ` · ${formatDate(currentStatementImport.periodStart)}–${formatDate(currentStatementImport.periodEnd)}` : ''}` : currentStatementImport.status === 'failed' ? ` · ${currentStatementImport.error ?? 'The complete ledger could not be proved.'}` : ''}</span></p></div>{currentStatementImport.status === 'awaiting_confirmation' && <button className="button primary" disabled={confirmingImportId === currentStatementImport.id} onClick={() => void confirmStatement(currentStatementImport)}>{confirmingImportId === currentStatementImport.id ? 'Importing…' : `Import ${currentStatementImport.transactionCount}`}</button>}</div>}
    {!currentStatementImport && statementResult && <div className="feed-statement-import feed-statement-complete" role="status"><div><p><strong>Statement checked</strong><span>{statementResult.filename} · {statementResult.imported} new · {statementResult.duplicates} already imported</span></p></div></div>}
    {runtimeMode === 'demo' && <div className="demo-banner"><BeakerIcon className="ui-icon"/><div><strong>Interactive local demo</strong><span>“Refresh from Xero” simulates an on-demand API synchronization. The production path performs the same checks through a secure backend worker.</span></div></div>}
    {currentBatch && <div className="analysis-progress-banner" role="status"><span className="analysis-spinner"/><div><strong>Analysing {currentBatch.succeeded + currentBatch.skipped + currentBatch.failed} of {currentBatch.total} new lines</strong><span>{currentBatch.analysing ? `${currentBatch.analysing} in progress` : 'Waiting for the next worker'}{currentBatch.retrying ? ` · ${currentBatch.retrying} retrying` : ''}</span></div></div>}
    <div className="feed-summary"><div><strong>{bankLines.filter(line => line.status !== 'reconciled').length}</strong><span>lines remaining</span></div><div className="progress"><span style={{ width: `${bankLines.length ? bankLines.filter(line => line.status === 'reconciled').length / bankLines.length * 100 : 0}%` }} /></div><p>{bankLines.filter(line => line.status === 'reconciled').length} of {bankLines.length} reconciled</p></div>
    <div className="filter-row">{filters.map(item => { const count = bankLines.filter(line => matchesFilter(line, item.key)).length; return <button key={item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>{item.label}<span>{count}</span></button>; })}</div>
    <div className="line-table">
      <div className="line-head"><span>Date</span><span>Statement line</span><span>Status</span><span className="align-right">Amount</span><span /></div>
      {visible.length ? visible.map(line => <button className="line-row" key={line.id} onClick={() => onSelect(line)}>
        <span className="line-date">{formatDate(line.postedAt)}</span><span className="line-description"><strong>{line.payee || line.description}</strong><small>{line.payee ? line.description : line.reference || 'No reference'}</small></span><span>{activeLineIds.has(line.id) ? <span className="pill pill-blue"><span className="pill-dot"/>Analysing</span> : <StatusPill status={line.status} />}</span><span className={`amount ${line.amountMinor > 0 ? 'in' : ''}`}>{line.amountMinor > 0 ? '+' : '−'}{formatMoney(line.amountMinor)}</span><span className="row-arrow"><ChevronRightIcon className="ui-icon ui-icon-sm"/></span>
      </button>) : <div className="empty-state"><div className="empty-icon"><CheckCircleIcon className="ui-icon ui-icon-xl"/></div><h3>No lines in this view</h3><p>Every bank line remains in Workbench until Xero confirms it is reconciled.</p></div>}
    </div>
  </div>;
}

function StatementUploader({ company, account, statementImports, workflow, onChanged, notify }: { company: Company; account: BankAccount; statementImports: StatementImport[]; workflow: WorkflowState; onChanged: () => Promise<void>; notify: Notify }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<StatementImport | null>(null);
  const canDelete = company.memberRole !== 'viewer';
  const recent = [...statementImports].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 4);
  const upload = async (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    setError('');
    try {
      for (const file of files) await repository.uploadStatement(company.id, account.id, file);
      await onChanged();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Could not upload the statement');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  const pick = (event: ChangeEvent<HTMLInputElement>) => void upload([...(event.target.files ?? [])]);
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void upload([...event.dataTransfer.files]);
  };
  const confirm = async (statementImport: StatementImport) => {
    setConfirmingId(statementImport.id);
    setError('');
    try { await repository.confirmStatementImport(company.id, statementImport.id); await onChanged(); }
    catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : 'Could not import the statement'); }
    finally { setConfirmingId(null); }
  };
  const statusCopy = (statementImport: StatementImport) => {
    if (statementImport.status === 'queued') return 'Waiting to be read';
    if (statementImport.status === 'processing') return 'Reading and verifying every transaction';
    if (statementImport.status === 'retryable') return 'Verification interrupted · retrying automatically';
    if (statementImport.status === 'awaiting_confirmation') return 'Ready for confirmation';
    if (statementImport.status === 'failed') return 'Could not be verified';
    if (statementImport.importedCount === 0) return `${statementImport.duplicateCount} transactions already known`;
    return `${statementImport.importedCount} imported${statementImport.duplicateCount ? ` · ${statementImport.duplicateCount} already known` : ''}`;
  };
  return <div className="statement-uploader">
    <div className={`statement-dropzone ${dragging ? 'dragging' : ''} ${uploading ? 'busy' : ''}`} onDragEnter={event => { event.preventDefault(); setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={drop}>
      <span className="statement-upload-icon"><ArrowUpTrayIcon className="ui-icon"/></span>
      <div><strong>{uploading ? 'Uploading statement…' : 'Drop bank statements here'}</strong><small>CSV, TSV, XLS, XLSX or PDF · up to 25 MB each</small></div>
      <label className={`button secondary upload-button ${uploading ? 'disabled' : ''}`}>{uploading ? 'Uploading…' : 'Choose files'}<input ref={inputRef} type="file" multiple disabled={uploading} accept=".csv,.tsv,.xls,.xlsx,.pdf,text/csv,text/tab-separated-values,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pick}/></label>
    </div>
    {error && <div className="statement-import-error" role="alert"><NoticeIcon tone="error"/><span>{error}</span></div>}
    {recent.length > 0 && <div className="statement-import-list">{recent.map(statementImport => <article className={`statement-import statement-import-${statementImport.status}`} key={statementImport.id}>
      <div className="statement-import-main"><span className="statement-file-icon"><DocumentIcon className="ui-icon"/></span><div><strong>{statementImport.filename}</strong><small>{statusCopy(statementImport)}</small></div>{['queued', 'processing', 'retryable'].includes(statementImport.status) && <span className="analysis-spinner"/>}{canDelete && <button className="icon-button statement-delete" aria-label={`Delete ${statementImport.filename}`} title="Delete this statement and its lines" onClick={() => setDeleting(statementImport)}><TrashIcon className="ui-icon"/></button>}</div>
      {statementImport.status === 'awaiting_confirmation' && <div className="statement-confirmation">
        <div className="statement-confirmation-head"><div><span>Workbench read this as</span><strong>{[statementImport.institution, statementImport.accountName, statementImport.accountIdentifier].filter(Boolean).join(' · ') || 'Bank statement'}</strong></div><span className="statement-proof">{statementImport.validation?.proofLevel === 'balanced' ? 'Balances verified' : statementImport.validation?.proofLevel === 'cross_checked' ? 'Two readings agreed' : 'Structure verified'}</span></div>
        <table><tbody><tr><th>Period</th><td>{statementImport.periodStart && statementImport.periodEnd ? `${formatDate(statementImport.periodStart)}–${formatDate(statementImport.periodEnd)}` : 'Not printed'}</td></tr><tr><th>Transactions</th><td>{statementImport.transactionCount}</td></tr><tr><th>Destination</th><td>{account.name}</td></tr></tbody></table>
        {statementImport.validation?.warnings?.length ? <p>{statementImport.validation.warnings.join(' ')}</p> : null}
        <button className="button primary" disabled={confirmingId === statementImport.id} onClick={() => void confirm(statementImport)}>{confirmingId === statementImport.id ? 'Importing…' : `Import ${statementImport.transactionCount} transaction${statementImport.transactionCount === 1 ? '' : 's'}`}</button>
      </div>}
      {statementImport.status === 'failed' && <div className="statement-failure"><strong>Workbench did not import any lines.</strong><p>{statementImport.error || statementImport.validation?.errors.join(' ') || 'The complete statement could not be proved.'}</p></div>}
    </article>)}</div>}
    {deleting && <DeleteStatementDialog company={company} statementImport={deleting} workflow={workflow} onClose={() => setDeleting(null)} onDeleted={async result => {
      setDeleting(null);
      await onChanged();
      notify(`${result.filename} deleted · ${result.deletedLines} line${result.deletedLines === 1 ? '' : 's'} removed${result.reopenedLines ? ` · ${result.reopenedLines} paired line${result.reopenedLines === 1 ? '' : 's'} reopened` : ''}`);
    }}/>}
  </div>;
}

function DeleteStatementDialog({ company, statementImport, workflow, onClose, onDeleted }: { company: Company; statementImport: StatementImport; workflow: WorkflowState; onClose: () => void; onDeleted: (result: StatementImportDeletionResult) => Promise<void> }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const plan = planStatementImportDeletion(statementImport, workflow.lines, workflow.candidateSets);
  const remove = async () => {
    setDeleting(true);
    setError('');
    try {
      const result = await repository.deleteStatementImport(company.id, statementImport.id);
      await onDeleted(result);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete the statement');
      setDeleting(false);
    }
  };
  return <div className="modal-layer"><button className="modal-scrim" aria-label="Cancel statement deletion" onClick={onClose}/><section className="modal destructive-modal" role="dialog" aria-modal="true" aria-labelledby="delete-statement-title">
    <header><div><p className="eyebrow">Permanent action</p><h2 id="delete-statement-title">Delete this statement?</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><XMarkIcon className="ui-icon"/></button></header>
    <div className="destructive-body">
      <p><strong>{statementImport.filename}</strong> and everything Workbench derived from it will be removed: {plan.lineIds.length} bank line{plan.lineIds.length === 1 ? '' : 's'}, their agent analysis, uploaded documents and audit events. The uploaded file is deleted from private storage.</p>
      {plan.lineIds.length === 0 && plan.blockers.length === 0 && <p>This statement produced no canonical lines, so only the upload record is removed.</p>}
      {plan.reopenedLineIds.length > 0 && <p>{plan.reopenedLineIds.length} paired transfer line{plan.reopenedLineIds.length === 1 ? '' : 's'} on another statement will return to <strong>New</strong>.</p>}
      {plan.blockers.length > 0 && <p className="destructive-warning">{plan.blockers.join(' ')}</p>}
      <p>Lines that deduplicated against an earlier statement are not affected. Nothing is deleted from Xero.</p>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="button secondary" disabled={deleting} onClick={onClose}>Cancel</button>
        <button className="button danger" disabled={deleting || !plan.deletable} onClick={() => void remove()}>{deleting ? 'Deleting…' : 'Permanently delete statement'}</button>
      </div>
    </div>
  </section></div>;
}

function Settings({ company, statementImports, workflow, xeroObservation, onChanged, onDeleted, notify }: { company: Company; statementImports: StatementImport[]; workflow: WorkflowState; xeroObservation?: XeroObservationProgress; onChanged: () => Promise<void>; onDeleted: () => Promise<void>; notify: Notify }) {
  const [draft, setDraft] = useState(company);
  const [xeroConnectUrl, setXeroConnectUrl] = useState<string | null>(null);
  const [startingXero, setStartingXero] = useState(false);
  const [xeroOptions, setXeroOptions] = useState<XeroCandidateOptions | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentProgress, setAgentProgress] = useState('');
  const [bootstrapThread, setBootstrapThread] = useState<AgentThread | null>(null);
  const operational = isOperational(draft.setup);
  const missingAttachmentScope = runtimeMode === 'supabase' && company.setup.xeroConnected && !hasXeroAttachmentScope(company.xeroScopes);
  useEffect(() => {
    if (runtimeMode !== 'supabase' || !company.setup.xeroConnected) return;
    void repository.getXeroCandidateOptions(company.id).then(setXeroOptions).catch(error => notify(friendlyError(error, 'Could not load Xero accounts'), 'error'));
  }, [company.id, company.setup.xeroConnected, notify]);
  useEffect(() => {
    if (runtimeMode !== 'supabase') return;
    if (company.setup.xeroConnected && !missingAttachmentScope) { xeroLinkCache.delete(company.id); return; }
    let cancelled = false;
    setStartingXero(true);
    void prepareXeroLink(company.id)
      .then(url => { if (!cancelled) setXeroConnectUrl(url); })
      .catch(error => { if (!cancelled) notify(friendlyError(error, 'Could not start the Xero connection'), 'error'); })
      .finally(() => { if (!cancelled) setStartingXero(false); });
    return () => { cancelled = true; };
  }, [company.id, company.setup.xeroConnected, missingAttachmentScope, notify]);
  useEffect(() => {
    if (runtimeMode !== 'supabase') return;
    void repository.getAgentThread(company.id).then(setBootstrapThread).catch(() => undefined);
  }, [company.id]);
  const checks = readinessChecks(draft.setup);
  const save = async (next = draft) => { setDraft(next); await repository.updateCompany(next); await onChanged(); notify('Company settings saved'); };
  const addBank = async () => {
    const accountNumber = draft.bankAccounts.length + 1;
    const name = accountNumber === 1 ? 'Business current' : accountNumber === 2 ? 'Business savings' : `Bank account ${accountNumber}`;
    const account: BankAccount = { id: crypto.randomUUID(), companyId: draft.id, name, currency: 'GBP', source: 'csv', xeroAccountId: null };
    const next = { ...draft, bankAccounts: [...draft.bankAccounts, account], lastOpenedBankAccountId: account.id, setup: { ...draft.setup, bankSourceConnected: true } };
    await save(next);
  };
  const bootstrap = async () => {
    setAgentBusy(true); setAgentProgress('Reading 12 months of Xero history…');
    try { const thread = await repository.bootstrapAgent(company.id); setBootstrapThread(thread); setAgentProgress('Company memory updated'); notify('Company memory updated'); }
    catch (error) { notify(friendlyError(error, 'Could not update company memory'), 'error'); setAgentProgress(''); }
    finally { setAgentBusy(false); }
  };
  return <div className="content settings-content">
    {!operational && <section className="setup-hero"><div><p className="eyebrow">Company readiness</p><h2>Finish setup to start reconciling</h2><p>The company is ready. Connect Xero and confirm the required accounting details to begin.</p></div><div className="setup-score"><strong>{checks.filter(check => check.complete).length}/{checks.length}</strong><span>complete</span></div></section>}
    <div className={`settings-layout ${operational ? 'settings-layout-single' : ''}`}><div className="settings-main">
      <section className="settings-card"><div className="settings-card-title"><span className="step-icon xero">X</span><div><h3>Xero organisation</h3><p>Workbench creates candidates; reconciliation always happens in Xero.</p></div></div>{draft.setup.xeroConnected ? <><div className="connected-row"><div><span className="connected-dot"/><strong>{draft.xeroTenantName ?? 'Connected Xero organisation'}</strong><small>{missingAttachmentScope ? 'Connected · attachment permission required' : 'Connected · organisation settings synced'}</small>{runtimeMode === 'supabase' && <small className={xeroObservation?.status === 'error' ? 'xero-observation-error' : ''}>{xeroObservationStatus(xeroObservation)}</small>}</div>{runtimeMode === 'demo' && <button className="text-button" onClick={() => void save({ ...draft, setup: { ...draft.setup, xeroConnected: false } })}>Disconnect</button>}</div>{missingAttachmentScope && <div className="xero-permission-warning"><div><NoticeIcon tone="warning"/><p><strong>Allow evidence attachments</strong><span>Reauthorise once. Workbench will then attach any pending documents automatically.</span></p></div>{xeroConnectUrl ? <a className="button secondary" href={xeroConnectUrl}>Reconnect Xero</a> : <button className="button secondary" disabled>{startingXero ? 'Preparing Xero…' : 'Reconnect unavailable'}</button>}</div>}</> : runtimeMode === 'demo' ? <button className="button primary full" onClick={() => void save({ ...draft, setup: { ...draft.setup, xeroConnected: true } })}>Connect Xero</button> : xeroConnectUrl ? <a className="button primary full" href={xeroConnectUrl}>Connect Xero</a> : <button className="button primary full" disabled>{startingXero ? 'Preparing Xero…' : 'Xero connection unavailable'}</button>}</section>
      <section className="settings-card"><div className="settings-card-title"><span className="step-icon"><BuildingLibraryIcon className="ui-icon"/></span><div><h3>Bank data</h3><p>Upload the bank's statement as CSV, spreadsheet or PDF. Workbench reads and verifies it without a mapping step.</p></div></div>{draft.bankAccounts.map(account => <div className="bank-source" key={account.id}><div className="bank-row"><div><strong>{account.name}</strong><small>{account.source === 'csv' ? 'Statement uploads' : 'Connected feed'} · GBP</small>{runtimeMode === 'supabase' && xeroOptions && <label className="bank-mapping">Matching Xero bank account<select value={account.xeroAccountId ?? ''} onChange={event => { const next = { ...draft, bankAccounts: draft.bankAccounts.map(item => item.id === account.id ? { ...item, xeroAccountId: event.target.value || null } : item) }; void save(next); }}><option value="">Choose…</option>{xeroOptions.bankAccounts.map(option => <option value={option.id} key={option.id}>{option.name}{option.code ? ` · ${option.code}` : ''}</option>)}</select></label>}</div></div><StatementUploader company={company} account={account} statementImports={statementImports.filter(statementImport => statementImport.bankAccountId === account.id)} workflow={workflow} onChanged={onChanged} notify={notify}/></div>)}<button className="button secondary full" onClick={() => void addBank()}><PlusIcon className="ui-icon"/>Add bank account</button></section>
      <section className="settings-card"><div className="settings-card-title"><span className="step-icon"><BanknotesIcon className="ui-icon"/></span><div><h3>Accounting settings</h3><p>Only values that cannot be read reliably from Xero are requested here.</p></div></div><div className="form-grid"><label>Base currency<select value={draft.setup.baseCurrency ?? ''} onChange={event => setDraft({ ...draft, setup: { ...draft.setup, baseCurrency: event.target.value === 'GBP' ? 'GBP' : null } })}><option value="">Choose…</option><option value="GBP">GBP — Pound sterling</option></select></label><label>VAT registered?<select value={draft.setup.vatRegistered === null ? '' : String(draft.setup.vatRegistered)} onChange={event => setDraft({ ...draft, setup: { ...draft.setup, vatRegistered: event.target.value === '' ? null : event.target.value === 'true', vatScheme: event.target.value === 'false' ? 'not_applicable' : draft.setup.vatScheme } })}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select></label>{draft.setup.vatRegistered && <label>VAT scheme<select value={draft.setup.vatScheme ?? ''} onChange={event => setDraft({ ...draft, setup: { ...draft.setup, vatScheme: event.target.value as Company['setup']['vatScheme'] } })}><option value="">Choose…</option><option value="standard">Standard</option><option value="cash">Cash accounting</option><option value="flat_rate">Flat rate</option></select></label>}</div><button className="button primary" onClick={() => void save()}>Save accounting settings</button></section>
      <section className="settings-card agent-card"><div className="settings-card-title"><span className="step-icon agent">AI</span><div><h3>Company memory</h3><p>The agent uses this company's Xero history and approved corrections when reviewing bank lines. Every recommendation still requires your approval.</p></div></div>{bootstrapThread ? <div className="agent-status"><strong>Ready</strong><small>Last updated {new Date(bootstrapThread.createdAt).toLocaleString('en-GB')}</small></div> : <p className="agent-empty">Company history has not been reviewed yet.</p>}<div className="agent-actions"><button className="button secondary" disabled={agentBusy || !company.setup.xeroConnected} onClick={() => void bootstrap()}>{agentBusy ? 'Updating…' : bootstrapThread ? 'Refresh company memory' : 'Review Xero history'}</button></div>{agentProgress && <p className="agent-progress">{agentProgress}</p>}</section>
      {draft.memberRole === 'owner' && <section className="settings-card danger-zone"><div><h3>Delete company</h3><p>Permanently remove this company and its Workbench data. Any accounting records already created in Xero will remain in Xero.</p></div><button className="button danger" onClick={() => setConfirmingDelete(true)}>Delete company</button></section>}
    </div>{!operational && <aside className="readiness-card"><h3>Readiness checklist</h3>{checks.map(check => <div className={check.complete ? 'done' : ''} key={check.id}><span>{check.complete ? <CheckIcon className="ui-icon ui-icon-sm"/> : <EllipsisHorizontalCircleIcon className="ui-icon ui-icon-sm"/>}</span><p><strong>{check.label}</strong><small>{check.complete ? 'Complete' : check.blocking ? 'Required before reconciling' : 'Optional'}</small></p></div>)}</aside>}</div>
    {confirmingDelete && <DeleteCompanyModal company={draft} onClose={() => setConfirmingDelete(false)} onDeleted={onDeleted} />}
  </div>;
}

function DeleteCompanyModal({ company, onClose, onDeleted }: { company: Company; onClose: () => void; onDeleted: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const confirmed = confirmation.toLocaleLowerCase('en-GB') === company.legalName.toLocaleLowerCase('en-GB');
  const remove = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError('');
    try {
      await repository.deleteCompany(company.id, confirmation);
      await onDeleted();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete company');
      setDeleting(false);
    }
  };
  return <div className="modal-layer"><button className="modal-scrim" aria-label="Cancel company deletion" onClick={onClose}/><section className="modal destructive-modal" role="dialog" aria-modal="true" aria-labelledby="delete-company-title"><header><div><p className="eyebrow">Permanent action</p><h2 id="delete-company-title">Delete {company.legalName}?</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><XMarkIcon className="ui-icon"/></button></header><div className="destructive-body"><p>This removes the company, members, bank lines, candidates and audit events from Workbench.</p>{company.setup.xeroConnected && <p className="destructive-warning">The connection to <strong>{company.xeroTenantName ?? 'the connected Xero organisation'}</strong> will be revoked first. Existing bills, invoices and transactions will not be deleted from Xero.</p>}<label>Type <strong>{company.legalName}</strong> to confirm<input autoFocus value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>{error && <p className="auth-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={deleting} onClick={onClose}>Cancel</button><button className="button danger" disabled={!confirmed || deleting} onClick={() => void remove()}>{deleting ? 'Deleting company…' : 'Permanently delete company'}</button></div></div></section></div>;
}

function timelineRunFromThread(thread: AgentThread): AgentTimelineRun {
  return { runId: thread.runId, parentRunId: thread.parentRunId, createdAt: thread.createdAt, userMessage: thread.userMessage, document: thread.document, reconsideration: thread.reconsideration, finalOutput: thread.finalOutput as AgentRecommendation };
}

function appendThreadTimeline(previous: AgentThread, current: AgentThread): AgentThread {
  const prior = previous.timeline?.length ? previous.timeline : previous.kind === 'line' ? [timelineRunFromThread(previous)] : [];
  return { ...current, timeline: [...prior.filter(run => run.runId !== current.runId), timelineRunFromThread(current)] };
}

function AgentRecommendationView({ recommendation, thread, accepting, canAccept, uploadInputId, messageInputId, onAccept }: { recommendation: AgentRecommendation; thread: AgentThread; accepting: boolean; canAccept: boolean; uploadInputId: string; messageInputId: string; onAccept: () => void }) {
  const operationLabels: Record<AgentRecommendation['proposedOperation'], string> = { create_new: 'Create new Xero record', match_existing: 'Match existing Xero record', request_information: 'Request information', human_review: 'Human review' };
  const candidateLabels = { bank_transaction: 'Bank transaction', bill: 'Supplier bill', invoice: 'Sales invoice', transfer: 'Bank transfer', none: 'None' } as const;
  const operation = recommendation.proposedOperation ? operationLabels[recommendation.proposedOperation] : 'Legacy shadow recommendation';
  const createsNew = recommendation.proposedOperation === 'create_new' || !recommendation.proposedOperation;
  const executable = canAccept && recommendation.outcome === 'recommend_candidate' && (
    (recommendation.proposedOperation === 'match_existing' && ['invoice', 'bank_transaction'].includes(recommendation.existingXeroEntityType)) ||
    (recommendation.proposedOperation === 'create_new' && ['bank_transaction', 'bill', 'invoice'].includes(recommendation.candidateKind))
  );
  const acceptanceNote = recommendation.proposedOperation === 'match_existing'
    ? 'Workbench checks the Xero record again before preparing the line.'
    : 'Workbench checks Xero again before creating anything.';
  const inspectedXeroDocuments = thread.xeroDocuments?.filter(document => document.entityId === recommendation.existingXeroEntityId) ?? [];
  if (recommendation.proposedOperation === 'request_information') {
    const question = recommendation.questions[0] || 'Provide the missing information so the agent can finish this line.';
    const requestsDocument = /\b(invoice|receipt|document|statement|evidence)\b/i.test(question);
    return <div className="agent-information-request">
      <span className="agent-action-label">Action needed</span>
      <h3>{requestsDocument ? 'Document needed' : 'Question from the agent'}</h3>
      <p className="agent-action-question">{question}</p>
      {requestsDocument ? <label className="button primary" htmlFor={uploadInputId}>Attach document</label> : <a className="button primary" href={`#${messageInputId}`}>Reply below</a>}
      <details><summary>Why this is needed</summary><p>{recommendation.summary}</p></details>
    </div>;
  }
  return <>
    <div className={`agent-outcome ${recommendation.outcome}`}><strong>{operation}</strong></div>
    <p>{recommendation.summary}</p>
    {recommendation.existingXeroEntityId && <div className="existing-xero-match">
      <span>Existing Xero record</span>
      <strong>{recommendation.existingXeroEntityType.replaceAll('_', ' ')}{recommendation.existingXeroEntityNumber ? ` · ${recommendation.existingXeroEntityNumber}` : ''}</strong>
      {recommendation.existingXeroMatchReason && <p>{recommendation.existingXeroMatchReason}</p>}
      {inspectedXeroDocuments.length > 0 && <div className="agent-inspected-evidence">
        <strong>Agent inspected {inspectedXeroDocuments.length === 1 ? 'its attachment' : `${inspectedXeroDocuments.length} attachments`}</strong>
        {inspectedXeroDocuments.map(document => <small key={document.attachmentId}>{document.filename}</small>)}
      </div>}
    </div>}
    {recommendation.candidateKind !== 'none' && <table className="agent-details" aria-label="Recommendation details"><caption>Recommendation details</caption><tbody><tr><th scope="row">Type</th><td>{candidateLabels[recommendation.candidateKind]}</td></tr><tr><th scope="row">Contact</th><td>{recommendation.contactName || 'Not resolved'}</td></tr>{createsNew && <><tr><th scope="row">Account</th><td>{recommendation.accountCode ? `${recommendation.accountCode} · ${recommendation.accountName}` : 'Not resolved'}</td></tr><tr><th scope="row">VAT</th><td>{taxTypeLabel(recommendation.taxType)}</td></tr>{['bill', 'invoice'].includes(recommendation.candidateKind) && <><tr><th scope="row">Document no.</th><td>{recommendation.reference || 'Not supplied'}</td></tr><tr><th scope="row">Document date</th><td>{recommendation.documentDate || 'Not resolved'}</td></tr><tr><th scope="row">Due date</th><td>{recommendation.dueDate || 'Not resolved'}</td></tr></>}</>}</tbody></table>}
    {executable && <div className="agent-accept"><button className="button primary full" disabled={accepting} onClick={onAccept}>{accepting ? 'Checking Xero…' : 'Use recommendation'}</button><p>{acceptanceNote}</p></div>}
    {recommendation.questions.length > 0 && <div className="agent-questions"><strong>Questions</strong>{recommendation.questions.map(question => <p key={question}>{question}</p>)}</div>}
  </>;
}

function LinePanel({ line, company, workflow, documents, onClose, onChanged }: { line: StatementLine; company: Company; workflow: WorkbenchSnapshot['workflow']; documents: LineDocument[]; onClose: () => void; onChanged: () => Promise<void>; notify: Notify }) {
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [agentThread, setAgentThread] = useState<AgentThread | null>(null);
  const [agentThreadLoading, setAgentThreadLoading] = useState(true);
  const [agentWorking, setAgentWorking] = useState(false);
  const [acceptingRecommendation, setAcceptingRecommendation] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const [chatWorking, setChatWorking] = useState(false);
  const [documentWorking, setDocumentWorking] = useState(false);
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null);
  const [syncingDocumentId, setSyncingDocumentId] = useState<string | null>(null);
  const [panelNotice, setPanelNotice] = useState<Notice | null>(null);
  const [documentNotice, setDocumentNotice] = useState<Notice | null>(null);
  const [queuedDocumentId, setQueuedDocumentId] = useState<string | null>(null);
  const [xeroReconnectUrl, setXeroReconnectUrl] = useState<string | null>(null);
  const [existingXeroAttachments, setExistingXeroAttachments] = useState<XeroAttachmentInfo[] | null>(null);
  const [existingAttachmentsError, setExistingAttachmentsError] = useState(false);
  const documentStatusKey = documents.map(document => `${document.id}:${document.analysisStatus}:${document.updatedAt}`).join('|');
  const analysisInFlight = documents.some(document => ['pending', 'processing'].includes(document.analysisStatus) && Date.now() - Date.parse(document.updatedAt || document.createdAt) < 120_000);
  const attachmentPermissionMissing = runtimeMode === 'supabase' && company.setup.xeroConnected && !hasXeroAttachmentScope(company.xeroScopes) && documents.some(document => document.analysisStatus === 'analysed' && !document.xeroUploadedAt);
  const lineResolved = Boolean(line.activeCandidateSetId) || ['prepared', 'reconciled'].includes(line.status);
  useEffect(() => {
    setAgentThread(null);
    setAgentThreadLoading(true);
    setChatMessage('');
    setPanelNotice(null);
    setDocumentNotice(null);
    setQueuedDocumentId(null);
    let cancelled = false;
    void repository.getAgentThread(company.id, line.id).then(thread => {
      if (!cancelled) setAgentThread(current => current ?? thread);
    }).catch(error => {
      if (!cancelled) setPanelNotice({ message: friendlyError(error, 'Could not load the agent conversation'), tone: 'error' });
    }).finally(() => {
      if (!cancelled) setAgentThreadLoading(false);
    });
    return () => { cancelled = true; };
  }, [company.id, line.id]);
  useEffect(() => {
    if (runtimeMode !== 'supabase' || !lineResolved || company.memberRole === 'viewer' || agentThread?.kind !== 'line') return;
    void repository.ensureHandbookPropagation(company.id, line.id, agentThread.runId).catch(() => undefined);
  }, [agentThread?.runId, company.id, company.memberRole, line.id, lineResolved]);
  useEffect(() => {
    let cancelled = false;
    const latestAnalysed = [...documents].filter(document => document.analysisStatus === 'analysed').sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (latestAnalysed) void repository.getAgentThread(company.id, line.id).then(thread => {
      if (!cancelled && thread?.document?.id === latestAnalysed.id) setAgentThread(thread);
    }).catch(() => undefined);
    if (latestAnalysed?.id === queuedDocumentId) {
      setDocumentNotice({ message: `${latestAnalysed.filename} analysed. The recommendation has been updated.`, tone: 'success' });
      setQueuedDocumentId(null);
    }
    const isStillRunning = () => documents.some(document => ['pending', 'processing'].includes(document.analysisStatus) && Date.now() - Date.parse(document.updatedAt || document.createdAt) < 120_000);
    if (!isStillRunning()) return () => { cancelled = true; };
    const timer = window.setInterval(() => {
      if (isStillRunning()) void onChanged();
      else { window.clearInterval(timer); void onChanged(); }
    }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [company.id, line.id, documentStatusKey, queuedDocumentId]);
  useEffect(() => {
    if (!attachmentPermissionMissing) { setXeroReconnectUrl(null); return; }
    let cancelled = false;
    void prepareXeroLink(company.id).then(url => { if (!cancelled) setXeroReconnectUrl(url); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [attachmentPermissionMissing, company.id]);
  const runAgent = async () => {
    setPanelNotice(null);
    setAgentWorking(true);
    try {
      const preflight = await repository.preflightXeroReconciliation(company.id, [line.id]);
      const result = preflight.results[0];
      await onChanged();
      if (result?.outcome === 'reconciled') { setPanelNotice({ message: 'Xero already reports this line as reconciled. Workbench linked the existing ledger movement; nothing was created.', tone: 'success' }); return; }
      if (result?.outcome === 'ambiguous') { setPanelNotice({ message: 'Possible existing Xero reconciliation found. Workbench did not create or recommend another record because the match is ambiguous.', tone: 'warning' }); return; }
      const thread = await repository.runShadowAgent(company.id, line.id);
      setAgentThread({ ...thread, timeline: [timelineRunFromThread(thread)] });
      await onChanged();
      setPanelNotice({ message: 'Analysis ready for review. Xero was not changed.', tone: 'info' });
    }
    catch (error) { setPanelNotice({ message: friendlyError(error, 'Could not analyse this line'), tone: 'error' }); }
    finally { setAgentWorking(false); }
  };
  const recommendation = agentThread?.kind === 'line' ? agentThread.finalOutput as AgentRecommendation : null;
  const activeSet = workflow.candidateSets.find(set => set.id === line.activeCandidateSetId);
  const reconciliationAmbiguous = line.note.startsWith('Possible existing Xero reconciliation');
  const xeroUrl = activeSet ? 'https://go.xero.com/Bank/BankAccounts.aspx' : null;
  useEffect(() => {
    if (runtimeMode !== 'supabase' || recommendation?.proposedOperation !== 'match_existing' || !['invoice', 'bank_transaction'].includes(recommendation.existingXeroEntityType) || !recommendation.existingXeroEntityId) {
      setExistingXeroAttachments(null);
      setExistingAttachmentsError(false);
      return;
    }
    let cancelled = false;
    setExistingXeroAttachments(null);
    setExistingAttachmentsError(false);
    void repository.getXeroAttachments(company.id, recommendation.existingXeroEntityType as 'invoice' | 'bank_transaction', recommendation.existingXeroEntityId)
      .then(attachments => { if (!cancelled) setExistingXeroAttachments(attachments); })
      .catch(() => { if (!cancelled) setExistingAttachmentsError(true); });
    return () => { cancelled = true; };
  }, [company.id, recommendation?.existingXeroEntityId, recommendation?.existingXeroEntityType, recommendation?.proposedOperation]);
  const acceptRecommendation = async () => {
    if (!agentThread || !recommendation) return;
    setPanelNotice(null);
    setAcceptingRecommendation(true);
    const request = { companyId: company.id, lineId: line.id, runId: agentThread.runId, statusVersion: line.statusVersion };
    try {
      const result = recommendation.proposedOperation === 'match_existing'
        ? await repository.acceptAgentMatch(request)
        : recommendation.proposedOperation === 'create_new'
          ? await repository.acceptAgentCreate(request)
          : null;
      if (!result) throw new Error('Ask the agent to resolve its questions before using this recommendation');
      if (result.attachments?.errors.length) {
        await onChanged();
        const permissionMissing = result.attachments.errors.some(error => isXeroAttachmentPermissionError(error.message));
        setPanelNotice({ message: permissionMissing ? 'The Xero entity was prepared, but this connection needs attachment permission. Reconnect Xero once below; Workbench will attach the document automatically.' : 'The Xero entity was prepared, but an attachment could not be sent. Retry it beside the affected document.', tone: 'warning' });
        return;
      }
      await onChanged();
      setPanelNotice({ message: recommendation.proposedOperation === 'match_existing' ? 'Existing Xero record validated and prepared.' : 'Recommendation created in Xero and prepared.', tone: 'success' });
    } catch (error) {
      await onChanged();
      const rawMessage = error instanceof Error ? error.message : '';
      const tone = rawMessage.startsWith('Xero already reports this bank line as reconciled') ? 'success' : rawMessage.startsWith('A possible existing Xero reconciliation') ? 'warning' : 'error';
      setPanelNotice({ message: friendlyError(error, 'The recommendation could not be used'), tone });
    }
    finally { setAcceptingRecommendation(false); }
  };
  const sendAgentMessage = async () => {
    const message = chatMessage.trim();
    if (!message || chatWorking || agentThreadLoading) return;
    setPanelNotice(null);
    setChatWorking(true);
    try {
      const thread = agentThread ?? await repository.runShadowAgent(company.id, line.id);
      const updated = await repository.continueAgent({ companyId: company.id, lineId: line.id, runId: thread.runId, statusVersion: thread.workflowProjection?.statusVersion ?? line.statusVersion, message });
      const merged = appendThreadTimeline(thread, updated);
      const refreshed = await repository.getAgentThread(company.id, line.id).catch(() => null);
      setAgentThread(refreshed ?? merged);
      setChatMessage('');
      await onChanged();
    } catch (error) { setPanelNotice({ message: friendlyError(error, 'Could not continue the agent conversation'), tone: 'error' }); }
    finally { setChatWorking(false); }
  };
  const uploadDocument = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || documentWorking || agentThreadLoading) return;
    setDocumentNotice(null);
    setDocumentWorking(true);
    try {
      const thread = agentThread ?? await repository.runShadowAgent(company.id, line.id);
      const result = await repository.uploadDocument({ companyId: company.id, lineId: line.id, runId: thread.runId, statusVersion: thread.workflowProjection?.statusVersion ?? line.statusVersion, file });
      if (result.thread) setAgentThread(appendThreadTimeline(thread, result.thread));
      if (result.document.analysisStatus !== 'analysed') setQueuedDocumentId(result.document.id);
      await onChanged();
      setDocumentNotice({ message: result.document.analysisStatus === 'analysed' ? `${file.name} analysed and the recommendation updated.` : `${file.name} uploaded. The agent is analysing it now; you can keep using Workbench.`, tone: 'info' });
    } catch (error) {
      await onChanged();
      setDocumentNotice({ message: friendlyError(error, 'Could not upload the document'), tone: 'error' });
    }
    finally { setDocumentWorking(false); }
  };
  const retryDocumentAnalysis = async (document: LineDocument) => {
    if (!agentThread) return;
    setDocumentNotice(null);
    setRetryingDocumentId(document.id);
    try {
      const result = await repository.retryDocumentAnalysis({ companyId: company.id, lineId: line.id, runId: agentThread.runId, statusVersion: line.statusVersion, documentId: document.id });
      if (result.thread) setAgentThread(result.thread);
      if (result.document.analysisStatus !== 'analysed') setQueuedDocumentId(result.document.id);
      await onChanged();
      setDocumentNotice({ message: `${document.filename} queued for analysis again.`, tone: 'info' });
    } catch (error) {
      await onChanged();
      setDocumentNotice({ message: friendlyError(error, 'Could not retry document analysis'), tone: 'error' });
    } finally { setRetryingDocumentId(null); }
  };
  const retryDocumentSync = async (document: LineDocument) => {
    setDocumentNotice(null);
    setSyncingDocumentId(document.id);
    try {
      await repository.syncDocumentToXero(company.id, document.id);
      await onChanged();
      setDocumentNotice({ message: `${document.filename} attached to the Xero entity.`, tone: 'success' });
    } catch (error) { setDocumentNotice({ message: friendlyError(error, 'Could not attach the document in Xero'), tone: 'error' }); }
    finally { setSyncingDocumentId(null); }
  };
  const needsDocument = recommendation?.proposedOperation === 'request_information';
  const canUploadEvidence = company.memberRole !== 'viewer';
  const preparedLabel = activeSet?.kind === 'bill' ? 'Authorised bill' : activeSet?.kind === 'invoice' ? 'Authorised invoice' : activeSet?.kind === 'transfer' ? 'Bank transfer' : 'Bank transaction';
  const sortedDocuments = [...documents].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const messageInputId = `agent-message-${line.id}`;
  const uploadInputId = `agent-document-${line.id}`;
  const timelineRuns = [...(agentThread?.timeline?.length ? agentThread.timeline : agentThread?.kind === 'line' ? [timelineRunFromThread(agentThread)] : [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const representedDocumentIds = new Set(timelineRuns.map(run => run.document?.id).filter(Boolean));
  const pendingTimelineDocuments = sortedDocuments.filter(document => !representedDocumentIds.has(document.id)).reverse();
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [line.id, line.status, agentThread?.runId, documentStatusKey]);
  const documentBubble = (document: LineDocument, key: string) => {
    const attached = Boolean(document.xeroUploadedAt);
    const syncFailed = Boolean(document.xeroUploadError);
    const permissionError = isXeroAttachmentPermissionError(document.xeroUploadError);
    const stale = document.analysisStatus === 'processing' && Date.now() - Date.parse(document.updatedAt || document.createdAt) >= 120_000;
    const retryable = document.analysisStatus === 'failed' || stale;
    const status = retryable ? 'Analysis interrupted' : document.analysisStatus !== 'analysed' ? 'Analysing in background' : attached ? 'Attached in Xero' : activeSet ? permissionError ? 'Reconnect Xero to attach' : syncFailed ? 'Attachment retry needed' : 'Attaching to Xero' : 'Used by agent';
    return <article className="chat-message chat-message-user chat-document" key={key}><div className="thread-message-meta"><strong>You attached a document</strong><span>{new Date(document.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div><div className="thread-document"><DocumentIcon className="ui-icon"/><div><strong>{document.filename}</strong><small>{(document.byteSize / 1024).toFixed(1)} KB · {status}</small>{document.analysisError && <em>{document.analysisError}</em>}{syncFailed && <em>{xeroAttachmentErrorMessage(document.xeroUploadError)}</em>}</div>{retryable ? <button className="button secondary" disabled={retryingDocumentId === document.id} onClick={() => void retryDocumentAnalysis(document)}>{retryingDocumentId === document.id ? 'Retrying…' : 'Retry'}</button> : activeSet && document.analysisStatus === 'analysed' && !attached && permissionError ? xeroReconnectUrl ? <a className="button secondary" href={xeroReconnectUrl}>Reconnect Xero</a> : <button className="button secondary" disabled>Preparing…</button> : activeSet && document.analysisStatus === 'analysed' && !attached && syncFailed ? <button className="button secondary" disabled={syncingDocumentId === document.id} onClick={() => void retryDocumentSync(document)}>{syncingDocumentId === document.id ? 'Retrying…' : 'Retry attachment'}</button> : null}</div></article>;
  };
  return <div className="panel-layer">
    <button className="panel-scrim" aria-label="Close panel" onClick={onClose}/>
    <aside className="line-panel line-thread-panel">
      <header><div><p className="eyebrow">Bank statement line</p><h2>{line.payee || line.description}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><XMarkIcon className="ui-icon"/></button></header>
      <div className="panel-body chat-panel-body">
        <div className="thread-line-summary">
          <div><StatusPill status={line.status}/><span>{formatDate(line.postedAt)} · {line.reference || line.description}</span><small>{company.bankAccounts.find(account => account.id === line.bankAccountId)?.name}</small></div>
          <strong className={line.amountMinor > 0 ? 'positive' : ''}>{line.amountMinor > 0 ? '+' : '−'}{formatMoney(line.amountMinor)}</strong>
        </div>
        <section className="chat-thread" ref={chatScrollRef} aria-label="Conversation">
          <div className="chat-system-event"><span>{formatDate(line.postedAt)}</span><p>Statement line imported from {company.bankAccounts.find(account => account.id === line.bankAccountId)?.source === 'csv' ? 'an uploaded statement' : 'the bank feed'}.</p></div>
          {agentThreadLoading && <article className="chat-message chat-message-agent chat-loading" role="status" aria-live="polite" aria-busy="true"><div className="thread-message-meta"><strong>Workbench agent</strong><span>Loading</span></div><div className="chat-loading-indicator" aria-hidden="true"><span/><span/><span/></div><h3>Loading conversation…</h3><p>Fetching the latest analysis, replies and supporting evidence.</p></article>}
          {timelineRuns.map((run, runIndex) => { const output = run.finalOutput; const internalEvidenceTurn = run.userMessage?.startsWith('Inspected '); const currentRun = run.runId === agentThread?.runId; const matchingDocument = run.document ? documents.find(document => document.id === run.document?.id) : null; return <div className="chat-turn" key={`${run.runId || 'legacy'}-${runIndex}`}>
            {run.reconsideration && <div className="chat-system-event chat-system-memory"><strong>Revisited after company memory changed</strong><p>{run.reconsideration.reason}</p><small>{run.reconsideration.handbookEntries.map(entry => entry.name.replaceAll('-', ' ')).join(', ')}</small></div>}
            {run.userMessage && !internalEvidenceTurn && (matchingDocument ? documentBubble(matchingDocument, `${run.runId}-document`) : <article className="chat-message chat-message-user"><div className="thread-message-meta"><strong>You</strong><span>{new Date(run.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div><p>{run.document?.filename ?? run.userMessage}</p></article>)}
            <article className="chat-message chat-message-agent"><div className="thread-message-meta"><strong>{run.document ? 'Workbench agent · reviewed document' : internalEvidenceTurn ? 'Workbench agent · inspected Xero evidence' : 'Workbench agent'}</strong><span>{new Date(run.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
              {currentRun && run.userMessage && output.reply && <p className="chat-direct-reply">{output.reply}</p>}
              {currentRun && !activeSet && line.status !== 'reconciled' ? <div className="chat-current-recommendation"><AgentRecommendationView recommendation={output} thread={agentThread!} accepting={acceptingRecommendation || analysisInFlight} canAccept={!analysisInFlight} uploadInputId={uploadInputId} messageInputId={messageInputId} onAccept={() => void acceptRecommendation()} />{output.proposedOperation === 'match_existing' && <div className="xero-evidence-summary"><strong>Evidence on the selected Xero record</strong>{existingXeroAttachments === null && !existingAttachmentsError ? <span>Checking attachments…</span> : existingAttachmentsError ? <span>Could not check attachments.</span> : (existingXeroAttachments?.length ?? 0) > 0 ? existingXeroAttachments?.map(attachment => <small key={attachment.id}>{attachment.filename}</small>) : <span>No attachments in Xero</span>}</div>}</div> : <p>{output.reply || output.summary}</p>}
            </article>
          </div>; })}
          {pendingTimelineDocuments.map(document => <div className="chat-turn" key={`pending-document-${document.id}`}>{documentBubble(document, `${document.id}-bubble`)}</div>)}
          {!agentThreadLoading && !agentThread && !activeSet && line.status !== 'reconciled' && <article className="chat-message chat-message-agent chat-ready"><div className="thread-message-meta"><strong>Workbench agent</strong><span>Now</span></div><h3>{agentWorking ? 'Checking Xero and company context…' : 'Ready to analyse this line'}</h3><p>{agentWorking ? 'I’m building the first response.' : 'Start the analysis, ask a question, or attach supporting evidence.'}</p>{!agentWorking && <button className="button primary" onClick={() => void runAgent()}>Analyse this line</button>}</article>}
          {reconciliationAmbiguous && <div className="chat-system-event chat-system-warning"><strong>Possible existing Xero reconciliation</strong><p>Workbench found similar reconciled ledger movements but could not prove a unique match.</p><a href="https://go.xero.com/Bank/BankAccounts.aspx" target="_blank" rel="noreferrer">Review in Xero</a></div>}
          {activeSet && line.status !== 'reconciled' && <div className="chat-system-event chat-system-status"><strong>{preparedLabel} prepared</strong><p>It is ready to reconcile in Xero{activeSet.kind === 'bill' || activeSet.kind === 'invoice' ? ' and remains here until Xero reports the payment reconciled' : ''}.</p><a className="button primary" href={xeroUrl ?? '#'} target="_blank" rel="noreferrer" onClick={() => sessionStorage.setItem('workbench-xero-return-company', company.id)}>Open in Xero</a></div>}
          {line.status === 'reconciled' && <div className="chat-system-event chat-system-status chat-system-complete"><strong>Reconciled in Xero</strong><p>Xero reports this bank line as reconciled.</p><a className="button primary" href={xeroUrl ?? 'https://go.xero.com/Bank/BankAccounts.aspx'} target="_blank" rel="noreferrer" onClick={() => sessionStorage.setItem('workbench-xero-return-company', company.id)}>Open in Xero</a></div>}
          {panelNotice && <div className={`panel-notice panel-notice-${panelNotice.tone}`} role={panelNotice.tone === 'error' ? 'alert' : 'status'}><NoticeIcon tone={panelNotice.tone}/><span>{panelNotice.message}</span></div>}
          {documentNotice && <div className={`panel-notice panel-notice-${documentNotice.tone}`} role={documentNotice.tone === 'error' ? 'alert' : 'status'}><NoticeIcon tone={documentNotice.tone}/><span>{documentNotice.message}</span></div>}
        </section>
        <section className="thread-composer chat-composer-fixed">
          <label htmlFor={messageInputId}>Message the agent</label>
          <div className="thread-composer-row"><textarea id={messageInputId} rows={3} value={chatMessage} disabled={agentThreadLoading || chatWorking || acceptingRecommendation || analysisInFlight} onChange={event => setChatMessage(event.target.value)} placeholder={agentThreadLoading ? 'Loading this conversation…' : needsDocument ? 'Answer the question or add context…' : 'Ask why, correct the recommendation, or add context…'}/><button className="button primary" disabled={agentThreadLoading || !chatMessage.trim() || chatWorking || acceptingRecommendation || analysisInFlight} onClick={() => void sendAgentMessage()}>{chatWorking ? 'Thinking…' : 'Send'}</button></div>
          <div className="thread-composer-actions">
            {canUploadEvidence && <label className={`button secondary upload-button ${documentWorking || agentThreadLoading ? 'disabled' : ''}`} htmlFor={uploadInputId}>{documentWorking ? 'Uploading…' : 'Attach document'}<input id={uploadInputId} aria-label="Upload document" type="file" disabled={documentWorking || agentThreadLoading} accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" onChange={event => void uploadDocument(event)} /></label>}
            <small>PDF or image · max 10 MB</small>
          </div>
        </section>
      </div>
    </aside>
  </div>;
}

function AddCompany({ onClose, onCreated }: { onClose: () => void; onCreated: (company: Company) => void }) {
  const [query, setQuery] = useState(''); const [results, setResults] = useState<CompaniesHouseResult[]>([]); const [searching, setSearching] = useState(false);
  useEffect(() => { const timer = window.setTimeout(async () => { if (query.trim().length < 2) { setResults([]); return; } setSearching(true); setResults(await repository.searchCompaniesHouse(query)); setSearching(false); }, 250); return () => window.clearTimeout(timer); }, [query]);
  return <div className="modal-layer"><button className="modal-scrim" aria-label="Close" onClick={onClose}/><section className="modal"><header><div><p className="eyebrow">New company</p><h2>Find a UK company</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><XMarkIcon className="ui-icon"/></button></header><p>Search Companies House by legal name or company number. Selecting a result creates the company immediately.</p><label className="search-box"><MagnifyingGlassIcon className="ui-icon"/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. Northstar Coffee or 09472813"/></label><div className="search-results">{searching && <p className="search-message">Searching Companies House…</p>}{!searching && query.length >= 2 && results.length === 0 && <p className="search-message">No matching active UK companies</p>}{results.map(result => <button key={result.number} onClick={async () => onCreated(await repository.createCompany(result))}><span className="company-avatar">{result.legalName.slice(0, 1)}</span><span><strong>{result.legalName}</strong><small>{result.number} · {result.registeredOffice}</small></span><ChevronRightIcon className="ui-icon"/></button>)}</div><div className="modal-note"><ShieldCheckIcon className="ui-icon"/><span>UK-only onboarding. Registered details are sourced from Companies House.</span></div></section></div>;
}

function AuthenticatedApp() {
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => { setSignedIn(Boolean(data.session)); setSessionReady(true); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { setSignedIn(Boolean(session)); setSessionReady(true); });
    return () => listener.subscription.unsubscribe();
  }, []);
  if (!sessionReady) return <div className="loading-screen"><div className="brand-mark">W</div><p>Checking your session…</p></div>;
  return signedIn ? <WorkbenchApp /> : <SignIn />;
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!supabase || !email) return;
    setError('');
    const { error: signInError } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    if (signInError) setError(signInError.message); else setSent(true);
  };
  return <div className="auth-page"><section className="auth-card"><div className="auth-brand"><span className="brand-mark">W</span><span>Workbench</span></div>{sent ? <><div className="auth-success"><CheckIcon className="ui-icon ui-icon-xl"/></div><h1>Check your email</h1><p>We sent a secure sign-in link to <strong>{email}</strong>.</p><button className="button secondary full" onClick={() => setSent(false)}>Use a different email</button></> : <><p className="eyebrow">UK bookkeeping operations</p><h1>Sign in to Workbench</h1><p>Enter your work email and we’ll send you a secure sign-in link.</p><label className="auth-field">Email address<input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void submit(); }} placeholder="you@practice.co.uk"/></label><button className="button primary full" disabled={!email} onClick={() => void submit()}>Email me a sign-in link</button>{error && <p className="auth-error">{error}</p>}</>}</section></div>;
}

function App() {
  return runtimeMode === 'supabase' ? <AuthenticatedApp /> : <WorkbenchApp />;
}

export default App;
