/** Local Web entry point with an explicit container listener. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { renderVideoReviewPage } from './video-editorial-settings.js';
import { VIDEO_ROLE_CONTRACTS, VIDEO_TOOL_CONTRACTS } from './video-role-contracts.js';
import { workflowRoute } from './workflow-http.js';
import { WorkflowError } from './workflow-plans.js';
import { exportText } from './text-export.js';
import { SearchSettingsError } from './search-settings.js';
import { createStudio } from './runtime.js';
import type { ExecutionMode, Studio, StudioOptions } from './types.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${name} 必须是 1–${max} 字符的文本`);
  return value;
}

const textRequestBytes = 14 * 1024 * 1024;

function requiredBodyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, label + '不能为空');
  return value;
}

async function body(req: IncomingMessage, limit = 131072): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, '请求过大');
    chunks.push(buffer);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'JSON 格式无效');
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

function templateInput(id: string, value: Record<string, unknown>): Parameters<Studio['saveTemplate']>[0] {
  if (value.id !== id) throw new HttpError(400, '模板 ID 不一致');
  const role = value.role;
  if (role !== 'orchestrator' && role !== 'manager' && role !== 'worker') throw new HttpError(400, 'Agent 角色无效');
  if (value.publicNetwork !== undefined && typeof value.publicNetwork !== 'boolean') throw new HttpError(400, '公开网络授权必须是布尔值');
  const selection = object(value.selection);
  if (typeof value.systemPrompt !== 'string') throw new HttpError(400, '职责设定必须是文本');
  const ids = (values: unknown) => {
    if (!Array.isArray(values) || !values.every(id => typeof id === 'string')) throw new HttpError(400, '配置引用必须是 ID 列表');
    return values as string[];
  };
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) throw new HttpError(400, '模板版本无效');
  return {
    ...(value.publicNetwork === undefined ? {} : {publicNetwork: value.publicNetwork as boolean}),
    id: text(id, '模板 ID', 100), name: text(value.name, '名称', 100), role,
    systemPrompt: value.systemPrompt,
    ...(value.skillIds === undefined ? {} : {skillIds: ids(value.skillIds)}),
    ...(value.delegateIds === undefined ? {} : {delegateIds: value.delegateIds === null ? null : ids(value.delegateIds)}),
    selection: {provider: text(selection.provider, 'Provider', 200), model: text(selection.model, '模型', 300),
      ...(selection.reasoningEffort !== undefined && selection.reasoningEffort !== '' ? {reasoningEffort: text(selection.reasoningEffort, '推理等级', 100)} : {})},
    ...(value.version === undefined ? {} : {version: value.version as number}),
  };
}

/** Start a local server; a supplied Studio is useful for HTTP boundary tests. */
export async function startServer(options: StudioOptions & {port?: number; containerListener?: boolean; publicDir?: string; studio?: Studio}) {
  if (options.containerListener && !existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) throw new Error('--container-listener requires a Docker or Podman container');
  const csrfToken = randomBytes(32).toString('hex');
  const clients = new Set<ServerResponse>();
  const shutdown = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let publishing = false;
  let pending = false;
  let studio: Studio;
  const publicDir = options.publicDir ?? fileURLToPath(new URL('../../public/', import.meta.url));
  const broadcast = async () => {
    if (publishing) { pending = true; return; }
    if (closing || clients.size === 0) return;
    publishing = true;
    try {
      const packet = `event: state\ndata: ${JSON.stringify(await studio.snapshot())}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 1_048_576) { client.end(); clients.delete(client); }
        else client.write(packet);
      }
    } catch { for (const client of clients) client.write('event: error\ndata: {"error":"状态读取失败"}\n\n'); }
    finally {
      publishing = false;
      if (pending && !closing) { pending = false; schedule(); }
    }
  };
  const schedule = () => {
    if (timer || closing) return;
    timer = setTimeout(() => { timer = undefined; void broadcast(); }, 40);
  };
  studio = options.studio ?? await createStudio({...options, onChange: () => { options.onChange?.(); schedule(); }});
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw new HttpError(403, '仅支持本机访问');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.origin !== `http://${host}`) throw new HttpError(403, '请求来源无效');
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        if (closing) throw new HttpError(503, '服务正在停止');
        if (req.headers.origin && req.headers.origin !== url.origin) throw new HttpError(403, '请求来源不匹配');
        const supplied = req.headers['x-studio-csrf'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) throw new HttpError(403, '请刷新页面后重试');
      }
      if (method === 'GET' && url.pathname === '/api/bootstrap') return send(res, 200, {csrfToken});
      if (method === 'GET' && url.pathname === '/api/state') return send(res, 200, await studio.snapshot());
      if (method === 'GET' && url.pathname === '/api/health') return send(res, 200, {ok: true, phase: 3, backend: 'dsh'});
      if (method === 'GET' && url.pathname === '/api/network/calls') return send(res, 200, studio.network.recent());
      if (url.pathname === '/api/network/settings') {
        if (method === 'GET') return send(res, 200, studio.network.settings.view());
        if (method === 'PUT') return send(res, 200, studio.network.settings.save(await body(req)));
      }
      if (method === 'GET' && url.pathname === '/api/models') return send(res, 200, (await studio.snapshot()).models);
      if (method === 'POST' && url.pathname === '/api/models/refresh') return send(res, 200, await studio.refreshModels());
      if (method === 'POST' && url.pathname === '/api/models/probe') {
        const input = await body(req);
        const selection = {
          provider: text(input.provider, 'Provider', 200), model: text(input.model, '模型', 300),
          ...(input.reasoningEffort === undefined ? {} : {reasoningEffort: text(input.reasoningEffort, '推理等级', 100)}),
        };
        const disconnected = new AbortController();
        const cancel = () => disconnected.abort();
        res.once('close', cancel);
        try {
          const result = await studio.probeModel(selection, AbortSignal.any([disconnected.signal, shutdown.signal]));
          if (!res.destroyed) send(res, 200, result);
          return;
        } finally { res.off('close', cancel); }
      }
      if (url.pathname.startsWith('/api/video')) {
        const video=studio.video;if(!video)throw new HttpError(404,'视频试点未启用：请设置 STUDIO_VIDEO_INPUT_ROOT 为专用素材目录');
        if(method==='GET'&&url.pathname==='/api/video/contracts')return send(res,200,{roles:VIDEO_ROLE_CONTRACTS,tools:VIDEO_TOOL_CONTRACTS});
        const plan=/^\/api\/video\/([a-zA-Z0-9_-]+)\/plan$/.exec(url.pathname);if(method==='GET'&&plan)return send(res,200,video.plan(plan[1]!));
        if(method==='GET'&&url.pathname==='/api/video')return send(res,200,video.list().map(job=>({job,review:(()=>{try{return video.review(job.id);}catch{return {status:'integrity_failed',publishAllowed:false};}})()})));
        if(method==='POST'&&url.pathname==='/api/video') {
          const value=await body(req),runId=text(value.runId,'Run ID',100),brief=text(value.brief,'任务说明',4000);
          const job=value.source?video.importForReview(runId,brief,text(value.source,'素材路径',4096)):video.create(runId,brief);
          return send(res,201,job);
        }
        const match=/^\/api\/video\/([a-zA-Z0-9_-]+)\/(stage|artifact|probe|decision|preview)$/.exec(url.pathname);
        if(match) {
          const [,id,action]=match;
          if(method==='GET'&&action==='preview') {
            const hash=text(url.searchParams.get('hash'),'文件哈希',64),data=video.preview(id!,hash);
            const range=req.headers.range;
            if(range) {
              const parts=/^bytes=(\d+)-(\d*)$/.exec(range);if(!parts)throw new HttpError(416,'无效范围');
              const start=Number(parts[1]),end=parts[2]?Math.min(Number(parts[2]),data.length-1):data.length-1;
              if(start>end||start>=data.length)throw new HttpError(416,'超出文件范围');
              res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':`bytes ${start}-${end}/${data.length}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'no-store'});return res.end(data.subarray(start,end+1));
            }
            res.writeHead(200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':data.length,'Cache-Control':'no-store'});return res.end(data);
          }
          if(method==='POST') {
            const value=await body(req);
            if(action==='stage')return send(res,202,{taskId:video.admit(id!,text(value.stage,'阶段',30) as import('./video-pipeline.js').VideoStage)});
            if(action==='artifact')return send(res,200,video.acceptArtifact(id!,text(value.stage,'阶段',30) as import('./video-pipeline.js').VideoStage,text(value.source,'素材路径',4096)));
            if(action==='probe')return send(res,200,await video.probe(id!));
            if(action==='decision') {
              if(typeof value.approved!=='boolean'||value.ownerAttestation!=='I reviewed this exact video')throw new HttpError(400,'需本人完整审看并明确选择');
              return send(res,200,video.decide(id!,text(value.hash,'文件哈希',64),value.approved,typeof value.note==='string'?value.note:''));
            }
          }
        }
        throw new HttpError(404,'未找到视频资源');
      }
      if (url.pathname.startsWith('/api/workflows/')) {
        if (!studio.workflows) throw new HttpError(404, '任务流程未启用');
        const output = /^\/api\/workflows\/instances\/([a-zA-Z0-9_-]+)\/nodes\/([a-zA-Z0-9_-]+)\/rounds\/(\d+)\/export$/.exec(url.pathname);
        if (method === 'GET' && output) {
          const [,instanceId,nodeId,round] = output;
          const format = url.searchParams.get('format');
          if (format !== 'docx' && format !== 'md') throw new HttpError(400, '请选择 Word 或 Markdown');
          const {title,content} = studio.workflows.releasedOutput(instanceId!,nodeId!,Number(round));
          const {mime,bytes} = exportText(title,content,format);
          res.writeHead(200, {'Content-Type':mime, 'Cache-Control':'no-store',
            'Content-Disposition': `attachment; filename="workflow-${instanceId}-${nodeId}-r${round}.${format}"`});
          return res.end(bytes);
        }
        const reply = workflowRoute(studio.workflows, method, url.pathname, method === 'GET' ? {} : await body(req, textRequestBytes));
        return send(res, reply.status, reply.data);
      }
      const skill = /^\/api\/skills(?:\/([a-zA-Z0-9_-]+))?$/.exec(url.pathname);
      if (skill) {
        const id = skill[1];
        if (method === 'GET') {
          if (!id) return send(res, 200, url.searchParams.get('includeRetired') === '1' ? studio.skills.directory() : studio.skills.list());
          const value = url.searchParams.get('version');
          if (value !== null && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new HttpError(400, '无效的 Skill 版本');
          return send(res, 200, studio.skills.read(id, value === null ? undefined : Number(value)));
        }
        if (method === 'POST' && !id) return send(res, 201, studio.skills.create(await body(req)));
        if (id && (method === 'PUT' || method === 'DELETE')) {
          const {expectedVersion, ...fields} = await body(req);
          return send(res, 200, studio.skills.revise(id, expectedVersion, fields, method === 'DELETE'));
        }
      }
      const taskRead = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/tasks\/([a-zA-Z0-9_-]+)\/(history|export)$/.exec(url.pathname);
      if (taskRead && method === 'GET') {
        const [,runId,taskId,kind] = taskRead;
        if (kind === 'history') return send(res, 200, await studio.taskHistory(runId!,taskId!,Number(url.searchParams.get('offset') ?? 0)));
        const format = url.searchParams.get('format');
        if (format !== 'docx' && format !== 'md') throw new HttpError(400,'请选择 Word 或 Markdown');
        const {title, content} = studio.taskOutput(runId!,taskId!);
        const {mime,bytes} = exportText(title,content,format);
        res.writeHead(200, {'Content-Type':mime,'Content-Disposition': `attachment; filename="task-${taskId}.${format}"`});
        return res.end(bytes);
      }
      const memory = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/memories(?:\/([a-zA-Z0-9_-]+))?$/.exec(url.pathname);
      if (method === 'GET' && memory) {
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
        if (memory[2]) return send(res, 200, await studio.readMemory(memory[1]!, {id: memory[2], offset, limit}));
        const layer = url.searchParams.get('layer');
        if (layer && !['long','medium','short'].includes(layer)) throw new HttpError(400, '记忆层级无效');
        return send(res, 200, await studio.listMemory(memory[1]!, {
          ...(layer ? {layer: layer as 'long'|'medium'|'short'} : {}),
          ...(url.searchParams.get('query') ? {query: url.searchParams.get('query')!} : {}),
          ...(url.searchParams.get('ownerAgentId') ? {ownerAgentId: url.searchParams.get('ownerAgentId')!} : {}),
          ...(url.searchParams.get('taskId') ? {taskId: url.searchParams.get('taskId')!} : {}), offset, limit,
        }));
      }
      const artifacts = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/attempts\/([a-zA-Z0-9_-]+)\/files(?:\/(read))?$/.exec(url.pathname);
      if (method === 'GET' && artifacts) {
        const path = url.searchParams.get('path') ?? '.';
        if (artifacts[3]) return send(res, 200, await studio.readArtifact(artifacts[1]!, artifacts[2]!, {path,
          ...(url.searchParams.has('offset') ? {offset: Number(url.searchParams.get('offset'))} : {}),
          ...(url.searchParams.has('limit') ? {limit: Number(url.searchParams.get('limit'))} : {})}));
        return send(res, 200, await studio.listArtifacts(artifacts[1]!, artifacts[2]!, {path}));
      }
      if (method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive'});
        res.write(': connected\n\n'); clients.add(res);
        req.on('close', () => clients.delete(res));
        schedule(); return;
      }
      const template = /^\/api\/templates\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (method === 'PUT' && template) {
        const result = await studio.saveTemplate(templateInput(template[1]!, await body(req, textRequestBytes)));
        schedule(); return send(res, 200, result);
      }
      if (method === 'POST' && url.pathname === '/api/runs') {
        const value = await body(req, textRequestBytes);
        if (!['auto', 'direct', 'hierarchical'].includes(String(value.mode))) throw new HttpError(400, '执行模式无效');
        const result = await studio.createRun({prompt: requiredBodyText(value.prompt, '任务'), mode: value.mode as ExecutionMode,
          ...(value.orchestratorTemplateId === undefined ? {} : {orchestratorTemplateId: text(value.orchestratorTemplateId, 'Orchestrator 模板', 100)}),
          ...(value.reuseMemoryFromRunId === undefined ? {} : {reuseMemoryFromRunId: text(value.reuseMemoryFromRunId, '长期记忆来源协作', 100)})});
        schedule(); return send(res, 201, result);
      }
      const tasks = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/tasks$/.exec(url.pathname);
      if (method === 'POST' && tasks) {
        const value = await body(req, textRequestBytes);
        const requestId = text(value.requestId, '提交 ID', 100);
        if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw new HttpError(400, '提交 ID 格式无效');
        const result = await studio.addTask(tasks[1]!, {prompt: requiredBodyText(value.prompt, '任务'), requestId,
          ...(value.targetManagerId === undefined ? {} : {targetManagerId: text(value.targetManagerId, 'Manager ID', 100)})});
        schedule(); return send(res, 202, result);
      }
      const taskAction = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/tasks\/([a-zA-Z0-9_-]+)\/(retry|cancel|pause|resume)$/.exec(url.pathname);
      if (method === 'POST' && taskAction) {
        if (taskAction[3] === 'pause' || taskAction[3] === 'resume') {
          const result = taskAction[3] === 'pause' ? await studio.pauseTask(taskAction[1]!, taskAction[2]!) : await studio.resumeTask(taskAction[1]!,taskAction[2]!);
          schedule(); return send(res, 202, result);
        }
        if (taskAction[3] === 'retry') {
          const result = await studio.retryTask(taskAction[1]!, taskAction[2]!);
          schedule(); return send(res, 202, result);
        }
        await studio.cancelTask(taskAction[1]!, taskAction[2]!);
        schedule(); return send(res, 202, {accepted: true});
      }
      const action = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/(messages|stop)$/.exec(url.pathname);
      if (method === 'POST' && action) {
        if (action[2] === 'messages') {
          const input = await body(req, textRequestBytes);
          await studio.sendMessage(action[1]!, requiredBodyText(input.text, '消息'), input.requestId === undefined ? undefined : text(input.requestId,'提交 ID',100));
        }
        else await studio.stopRun(action[1]!);
        schedule(); return send(res, 202, {accepted: true});
      }
      const staticFiles: Record<string, {file: string; mime: string}> = {
        '/': {file: 'index.html', mime: 'text/html; charset=utf-8'},
        '/index.html': {file: 'index.html', mime: 'text/html; charset=utf-8'},
        '/workflows.html': {file:'workflows.html', mime:'text/html; charset=utf-8'},
        '/workflow-inputs.js': {file:'workflow-inputs.js', mime:'text/javascript; charset=utf-8'},
        '/workflows.js': {file:'workflows.js', mime:'text/javascript; charset=utf-8'},
        '/workflows.css': {file:'workflows.css', mime:'text/css; charset=utf-8'},
        '/skills.html': {file:'skills.html', mime:'text/html; charset=utf-8'},
        '/skills.js': {file:'skills.js', mime:'text/javascript; charset=utf-8'},
        '/network.html': {file: 'network.html', mime: 'text/html; charset=utf-8'},
        '/network.js': {file: 'network.js', mime: 'text/javascript; charset=utf-8'},
        '/video.html': {file: 'video.html', mime: 'text/html; charset=utf-8'},
        '/video.js': {file: 'video.js', mime: 'text/javascript; charset=utf-8'},
        '/app.js': {file: 'app.js', mime: 'text/javascript; charset=utf-8'},
        '/styles.css': {file: 'styles.css', mime: 'text/css; charset=utf-8'},
      };
      const asset = staticFiles[url.pathname];
      if ((method === 'GET' || method === 'HEAD') && asset) {
        const content = await readFile(join(publicDir, asset.file));
        res.writeHead(200, {'Content-Type': asset.mime, 'Cache-Control': 'no-cache'});
        if (method === 'HEAD') return res.end();
        return res.end(asset.file === 'video.html' ? renderVideoReviewPage(content.toString('utf8')) : content);
      }
      throw new HttpError(404, '未找到此资源');
    })().catch((error: unknown) => {
      if (res.headersSent) { res.end(); return; }
      const message = error instanceof Error ? error.message : '请求失败';
      const status = error instanceof HttpError || error instanceof WorkflowError || error instanceof SearchSettingsError ? error.status : /version conflict/i.test(message) ? 409 : /not found|不存在|unknown run|unknown task|unknown skill/i.test(message) ? 404 : 400;
      send(res, status, {error: message.slice(0, 600)});
    });
  });
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 20_000);
  heartbeat.unref();
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, options.containerListener ? '0.0.0.0' : '127.0.0.1', () => {server.off('error', reject); accept();}); });
  } catch (error) { clearInterval(heartbeat); await studio.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener did not return a TCP address');
  let closePromise: Promise<void> | undefined;
  return {
    server, studio, url: `http://127.0.0.1:${address.port}`,
    close(): Promise<void> {
      return closePromise ??= (async () => {
        closing = true; shutdown.abort(); clearInterval(heartbeat); if (timer) clearTimeout(timer);
        for (const client of clients) client.end(); clients.clear();
        await new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeIdleConnections(); });
        await studio.close();
      })();
    },
  };
}

async function main(): Promise<void> {
  const {values} = parseArgs({options: {'port': {type: 'string'}, 'data-dir': {type: 'string'}, 'dsh-home': {type: 'string'}, 'container-listener': {type: 'boolean'}, help: {type: 'boolean'}}});
  if (values.help) { console.log('Agent Studio Phase 3\n  --port 4317\n  --container-listener (publish the Docker port on host 127.0.0.1)\n  --data-dir .studio\n  --dsh-home <existing DSH configuration directory>\n  STUDIO_MAX_WORKERS=4\n  STUDIO_DEMO_DELAY_MS=0\n  STUDIO_CONTAINER_IMAGE=<trusted local image digest> (enables offline containers)'); return; }
  const port = Number(values.port ?? process.env.STUDIO_PORT ?? '4317');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port 必须是 0–65535 的整数');
  const dshHome = process.env.STUDIO_DEMO === '1' ? undefined : values['dsh-home'] ?? process.env.STUDIO_DSH_HOME ?? process.env.DSH_HOME;
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
    return value;
  };
  const scheduler = {maxActiveWorkers: integer('STUDIO_MAX_WORKERS', 4, 1, 24),
    pollIntervalMs: integer('STUDIO_POLL_INTERVAL_MS', 50, 10, 60000),
    maxDeliveryAttempts: integer('STUDIO_MAX_DELIVERY_ATTEMPTS', 3, 1, 20),
    retryDelayMs: integer('STUDIO_RETRY_DELAY_MS', 500, 10, 60000)};
  const demoDelayMs = integer('STUDIO_DEMO_DELAY_MS', 0, 0, 60000);
  const autoCompact = process.env.STUDIO_COMPACTION_AUTO ?? 'true';
  if (!['true','false'].includes(autoCompact)) throw new Error('STUDIO_COMPACTION_AUTO 必须为 true 或 false');
  const compaction = {auto: autoCompact === 'true',
    ...(process.env.STUDIO_COMPACTION_THRESHOLD === undefined ? {} : {thresholdRatio: Number(process.env.STUDIO_COMPACTION_THRESHOLD)}),
    ...(process.env.STUDIO_COMPACTION_RETAIN === undefined ? {} : {retainRatio: Number(process.env.STUDIO_COMPACTION_RETAIN)}),
    ...(process.env.STUDIO_COMPACTION_MAX_TOKENS === undefined ? {} : {maxTokens: Number(process.env.STUDIO_COMPACTION_MAX_TOKENS)})};
  const image = process.env.STUDIO_CONTAINER_IMAGE;
  const execution = image ? {enabled: true, image,
    timeoutMs: integer('STUDIO_EXEC_TIMEOUT_MS', 30000, 100, 300000),
    maxOutputBytes: integer('STUDIO_EXEC_OUTPUT_BYTES', 65536, 1024, 1048576),
    maxFileBytes: integer('STUDIO_EXEC_FILE_BYTES', 65536, 1024, 1048576),
    memoryMb: integer('STUDIO_EXEC_MEMORY_MB', 256, 64, 4096),
    cpus: Number(process.env.STUDIO_EXEC_CPUS ?? 1),
    pidsLimit: integer('STUDIO_EXEC_PIDS', 64, 16, 512)} : {enabled: false};
  const app = await startServer({...(process.env.STUDIO_VIDEO_INPUT_ROOT ? {videoInputRoot:resolve(process.env.STUDIO_VIDEO_INPUT_ROOT)} : {}), containerListener: values['container-listener'], port, scheduler, demoDelayMs, execution, compaction, dataDir: resolve(values['data-dir'] ?? process.env.STUDIO_DATA_DIR ?? '.studio'), ...(dshHome ? {dshHome: resolve(dshHome)} : {})});
  console.log(`Agent Studio · Phase 3\nLocal: ${app.url}\nSQLite 三层记忆已启用；Worker ${image ? '使用本地隔离容器，外网关闭' : '使用无副作用探针（设置 STUDIO_CONTAINER_IMAGE 启用容器）'}。`);
  const stop = () => { void app.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : '启动失败'); process.exitCode = 1; });
}
