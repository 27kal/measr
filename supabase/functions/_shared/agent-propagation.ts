import { Agent, run } from 'npm:@openai/agents@0.13.5';
import { z } from 'npm:zod@4.4.3';
import { artifactPaths, readJson, readText, writeJson } from './agent-artifacts.ts';
import { reconsiderLineForHandbookChange, type HandbookReconsideration } from './agent-runtime.ts';
import { handbookEntryNamesFromThread } from './agent-propagation-history.ts';

type Service = any;
type Row = Record<string, any>;

const MODEL = Deno.env.get('OPENAI_AGENT_MODEL') ?? 'gpt-5.6';

export interface HandbookChange {
  name: string;
  content: string;
}

interface PropagationTarget {
  lineId: string;
  statusVersion: number;
  reason: string;
  status: 'pending' | 'completed' | 'skipped' | 'failed';
  resultRunId?: string;
  detail?: string;
}

interface PropagationArtifact {
  schemaVersion: 1;
  sourceRunId: string;
  sourceLineId: string;
  bankAccountId: string;
  handbookChanges: HandbookChange[];
  status: 'screening' | 'running' | 'complete';
  targets: PropagationTarget[];
  createdAt: string;
  updatedAt: string;
}

const relevanceOutput = z.object({
  affected: z.array(z.object({
    lineId: z.string(),
    reason: z.string()
  }))
});

async function currentHandbookChanges(service: Service, companyId: string, thread: Row): Promise<HandbookChange[]> {
  const changes: HandbookChange[] = [];
  for (const name of handbookEntryNamesFromThread(thread)) {
    const content = await readText(service, artifactPaths.handbookEntry(companyId, name));
    if (content) changes.push({ name, content });
  }
  return changes;
}

function compactLine(line: Row) {
  return {
    id: String(line.id),
    statusVersion: Number(line.status_version),
    postedAt: String(line.posted_at),
    amountMinor: Number(line.amount_minor),
    payee: String(line.payee ?? ''),
    description: String(line.description ?? ''),
    reference: String(line.reference ?? ''),
    status: String(line.status),
    currentNote: String(line.note ?? '')
  };
}

async function screenRelevantLines(changes: HandbookChange[], lines: Row[]) {
  if (!lines.length) return [] as Array<{ lineId: string; reason: string }>;
  const allowedIds = new Set(lines.map(line => String(line.id)));
  const agent = new Agent({
    name: 'Workbench handbook propagation screener',
    model: MODEL,
    modelSettings: { reasoning: { effort: 'low' }, text: { verbosity: 'low' }, parallelToolCalls: false, maxTokens: 1600 },
    outputType: relevanceOutput,
    instructions: `Decide which unresolved bank statement lines should be reconsidered because the company handbook changed.

This is relevance screening only. Do not choose an accounting treatment. Default to unaffected. Select a line only when a changed rule could materially change its existing analysis, answer an outstanding question, or apply directly to its payee, contact, amount, description or transaction pattern. Superficial similarity is not enough. Return only IDs from the supplied list and give one concise reason per selected line.`
  });
  const result = await run(agent, `Changed handbook entries:\n${JSON.stringify(changes)}\n\nUnresolved lines in the same bank account:\n${JSON.stringify(lines.map(compactLine))}`, { maxTurns: 1 });
  if (!result.finalOutput) throw new Error('Handbook relevance screening returned no output');
  return result.finalOutput.affected.filter(target => allowedIds.has(target.lineId));
}

async function savePropagation(service: Service, companyId: string, artifact: PropagationArtifact) {
  artifact.updatedAt = new Date().toISOString();
  await writeJson(service, artifactPaths.propagation(companyId, artifact.sourceRunId), artifact);
}

async function unresolvedSiblingLines(service: Service, companyId: string, sourceLineId: string, bankAccountId: string): Promise<Row[]> {
  const { data, error } = await service.from('statement_lines')
    .select('id,bank_account_id,posted_at,amount_minor,payee,description,reference,status,status_version,note,active_candidate_set_id')
    .eq('company_id', companyId)
    .eq('bank_account_id', bankAccountId)
    .neq('id', sourceLineId)
    .in('status', ['new', 'needs_you'])
    .is('active_candidate_set_id', null);
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

export async function propagateAcceptedHandbookChanges(service: Service, companyId: string, sourceLine: Row, sourceThread: Row) {
  const path = artifactPaths.propagation(companyId, String(sourceThread.runId));
  let artifact = await readJson<PropagationArtifact>(service, path);
  if (artifact?.status === 'complete') return artifact;

  if (!artifact) {
    const changes = await currentHandbookChanges(service, companyId, sourceThread);
    if (!changes.length) return null;
    artifact = {
      schemaVersion: 1,
      sourceRunId: String(sourceThread.runId),
      sourceLineId: String(sourceLine.id),
      bankAccountId: String(sourceLine.bank_account_id),
      handbookChanges: changes,
      status: 'screening',
      targets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await savePropagation(service, companyId, artifact);
  }

  if (artifact.status === 'screening') {
    const candidates = await unresolvedSiblingLines(service, companyId, artifact.sourceLineId, artifact.bankAccountId);
    const affected = await screenRelevantLines(artifact.handbookChanges, candidates);
    const byId = new Map(candidates.map(line => [String(line.id), line]));
    artifact.targets = affected.map(target => ({
      lineId: target.lineId,
      statusVersion: Number(byId.get(target.lineId)!.status_version),
      reason: target.reason,
      status: 'pending'
    }));
    artifact.status = 'running';
    await savePropagation(service, companyId, artifact);
  }

  const [{ data: company, error: companyError }, { data: bankAccount, error: bankError }] = await Promise.all([
    service.from('companies').select('id,legal_name,companies_house_number,base_currency,vat_registered,vat_scheme').eq('id', companyId).maybeSingle(),
    service.from('bank_accounts').select('id,name,currency,source,xero_account_id').eq('id', artifact.bankAccountId).eq('company_id', companyId).maybeSingle()
  ]);
  if (companyError || bankError || !company || !bankAccount) throw new Error(companyError?.message ?? bankError?.message ?? 'Propagation context no longer exists');

  for (const target of artifact.targets.filter(item => item.status === 'pending' || item.status === 'failed')) {
    try {
      const [{ data: line, error: lineError }, previousThread] = await Promise.all([
        service.from('statement_lines').select('*').eq('company_id', companyId).eq('id', target.lineId).maybeSingle(),
        readJson<Row>(service, artifactPaths.lineThread(companyId, target.lineId))
      ]);
      if (lineError) throw new Error(lineError.message);
      if (!line || String(line.bank_account_id) !== artifact.bankAccountId || line.active_candidate_set_id || !['new', 'needs_you'].includes(String(line.status))) {
        target.status = 'skipped';
        target.detail = 'Line was resolved, moved or removed before reconsideration.';
        await savePropagation(service, companyId, artifact);
        continue;
      }
      if (previousThread?.reconsideration?.sourceRunId === artifact.sourceRunId) {
        target.status = 'completed';
        target.resultRunId = String(previousThread.runId);
        target.detail = 'Already reconsidered for this handbook change.';
        await savePropagation(service, companyId, artifact);
        continue;
      }
      if (Number(line.status_version) !== target.statusVersion) {
        target.status = 'skipped';
        target.detail = 'Line changed after relevance screening; its newer conversation was preserved.';
        await savePropagation(service, companyId, artifact);
        continue;
      }
      const reconsideration: HandbookReconsideration = {
        sourceRunId: artifact.sourceRunId,
        sourceLineId: artifact.sourceLineId,
        handbookEntries: artifact.handbookChanges,
        reason: target.reason
      };
      const result = await reconsiderLineForHandbookChange(service, companyId, line, company, bankAccount, previousThread, reconsideration);
      target.status = 'completed';
      target.resultRunId = String(result.runId);
      target.detail = 'A fresh recommendation is ready for human review.';
    } catch (error) {
      target.status = 'failed';
      target.detail = error instanceof Error ? error.message : 'Automatic reconsideration failed';
      console.error('handbook propagation target failed', { companyId, sourceRunId: artifact.sourceRunId, targetLineId: target.lineId, error });
    }
    await savePropagation(service, companyId, artifact);
  }

  artifact.status = 'complete';
  await savePropagation(service, companyId, artifact);
  return artifact;
}

export function scheduleAcceptedHandbookPropagation(service: Service, companyId: string, sourceLine: Row, sourceThread: Row) {
  const task = propagateAcceptedHandbookChanges(service, companyId, sourceLine, sourceThread).catch(error => {
    console.error('handbook propagation failed', { companyId, sourceRunId: sourceThread.runId, error });
  });
  const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(task);
  else void task;
}
