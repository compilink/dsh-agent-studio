import { randomUUID } from 'node:crypto';
import { publicNetworkOperation } from './public-network.js';
import { SearchSettingsStore } from './search-settings.js';
import type { StudioStore, StoredAgent } from './store.js';
import type { AgentTemplate } from './types.js';

type Operation = 'search'|'fetch';
type Binding = Pick<StoredAgent, 'id'|'role'|'runId'|'templateId'|'templateVersion'>;
type Outcome = 'allowed'|'denied'|'failed';
interface AuditSource {title: string; url: string; retrievedAt: string}
interface NetworkCall {
  runId: string; taskId: string; attemptId: string; workerId: string; operation: Operation; outcome: Outcome;
  at: string; sources: AuditSource[];
}

/** A Worker must have existed under the current grant period. Re-granting never revives an old grant. */
export class NetworkGrants {
  readonly settings: SearchSettingsStore;
  private readonly active = new Map<string,Set<AbortController>>();
  constructor(private readonly store: StudioStore, private readonly transport = publicNetworkOperation) {
    this.settings = new SearchSettingsStore(store.db, process.env.STUDIO_BUNDLED_SEARCH === '1');
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS studio_network_grants(template_id TEXT PRIMARY KEY REFERENCES templates(id), id TEXT UNIQUE NOT NULL, first_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_network_calls(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        worker_id TEXT NOT NULL, grant_id TEXT, operation TEXT NOT NULL, outcome TEXT NOT NULL, at TEXT NOT NULL, sources TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS studio_network_attempt ON studio_network_calls(attempt_id,outcome);`);
  }

  /** Called inside the transaction that updates the corresponding template. */
  configure(template: AgentTemplate) {
    const current = this.store.db.prepare('SELECT id FROM studio_network_grants WHERE template_id=?').get(template.id);
    if (template.publicNetwork && !current) {
      this.store.db.prepare('INSERT INTO studio_network_grants VALUES(?,?,?)').run(template.id,randomUUID(),template.version);
    } else if (!template.publicNetwork && current) {
      this.store.db.prepare('DELETE FROM studio_network_grants WHERE template_id=?').run(template.id);
      this.store.afterCommit(() => {
        for (const request of this.active.get(String(current.id)) ?? []) request.abort();
      });
    }
  }

  grant(worker: Binding): string | undefined {
    if (worker.role !== 'worker') return;
    const row = this.store.db.prepare('SELECT id FROM studio_network_grants WHERE template_id=? AND first_version<=?').get(worker.templateId, worker.templateVersion);
    return row ? String(row.id) : undefined;
  }

  recent(): NetworkCall[] {
    return this.store.db.prepare(`SELECT run_id runId, task_id taskId, attempt_id attemptId, worker_id workerId,
      operation, outcome, at, sources FROM studio_network_calls ORDER BY id DESC LIMIT 50`).all()
      .map(row => ({...row,sources:JSON.parse(String(row.sources))}) as NetworkCall);
  }

  async execute(worker: Binding, taskId: string, attemptId: string, operation: Operation, value: string, signal: AbortSignal) {
    const grant = this.grant(worker);
    const audit = (outcome: Outcome, sources: AuditSource[] = []) => this.store.db.prepare(`INSERT INTO studio_network_calls(
      run_id,task_id,attempt_id,worker_id,grant_id,operation,outcome,at,sources) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(worker.runId,taskId,attemptId,worker.id,grant ?? null,operation,outcome,new Date().toISOString(),JSON.stringify(sources));
    if (!grant) { audit('denied'); throw new Error('Worker 未获公开网络授权'); }
    const allowed = () => this.grant(worker) === grant;
    const controller = new AbortController();
    const requests = this.active.get(grant) ?? new Set<AbortController>();
    requests.add(controller); this.active.set(grant, requests);
    try {
      const known = operation === 'fetch' && value.includes('?') && !!this.store.db.prepare(`SELECT 1 FROM studio_network_calls c,json_each(c.sources) s
        WHERE c.attempt_id=? AND c.worker_id=? AND c.grant_id=? AND c.outcome='allowed' AND json_extract(s.value,'$.url')=? LIMIT 1`)
        .get(attemptId,worker.id,grant,value);
      const request = AbortSignal.any([signal,controller.signal]);
      const settings = this.settings.read();
      if (operation === 'search' && !this.settings.bundled && !settings.endpoint && settings.sources.some(id => id !== 'wikipedia')) {
        throw new Error('所选来源需要公开 HTTPS 搜索地址或已启用的独立搜索服务');
      }
      const result = await this.transport(operation,value,request,settings,known);
      request.throwIfAborted();
      if (!allowed()) throw new Error('Worker 的公开网络权限已关闭');
      const sources = result.sources ?? (result.source ? [result.source] : []);
      audit('allowed', sources.map(({title,url,retrievedAt}) => ({title,url,retrievedAt})));
      return result;
    } catch (error) {
      audit(allowed() ? 'failed' : 'denied');
      throw error;
    } finally {
      requests.delete(controller);
      if (!requests.size) this.active.delete(grant);
    }
  }
}
