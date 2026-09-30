import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { TaskService } from './service.js';
import { FeishuGateway } from './adapters/feishu.js';
import { MessageRouter } from './adapters/messages.js';
import { acquireWorkerLock } from './infra/lock.js';
import { startAdmin } from './admin/server.js';
import type { Management } from './management.js';

export async function runWorker(service: TaskService, useFeishu: boolean, once: boolean, management?: Management, port = 4318, onReady?: () => Promise<void>): Promise<void> {
  const release = await acquireWorkerLock(join(service.config.dataDirectory, 'worker.lock'));
  const routingController = new AbortController();
  let gateway: FeishuGateway | undefined;
  const router = new MessageRouter(service, service, routingController.signal, (message, signal) => gateway ? gateway.prepareMessage(message, service.attachments, signal) : Promise.resolve(message));
  let stopping = false;
  let delivery: Promise<void> | undefined;
  let routing: Promise<void> | undefined;
  let transportFailure: Error | undefined;
  let admin: Awaited<ReturnType<typeof startAdmin>> | undefined;
  let evaluation: Promise<void> | undefined;
  const stop = () => { stopping = true; service.health.worker = 'stopping'; routingController.abort(new Error('服务停止')); service.interruptActive(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let inboxTimer: NodeJS.Timeout | undefined;
  try {
    service.recoverInterrupted();
    if (management) {
      management.recoverEvaluations();
      admin = await startAdmin(management, { port });
      console.info(`管理后台：${admin.origin}（完整本机访问链接见 ${join(service.config.dataDirectory, 'admin.url')}）`);
    }
    if (useFeishu) { gateway = new FeishuGateway(service.store); await gateway.connect(error => { transportFailure = error; stop(); }); }
    service.health.worker = 'running'; service.health.feishu = useFeishu ? 'connected' : 'disabled';
    const receive = () => {
      service.health.heartbeatAt = new Date().toISOString();
      routing ??= router.dispatchPending().catch(error => { if (!stopping) console.error('收件队列处理失败，保留未确认消息', String(error)); }).finally(() => { routing = undefined; });
      if (gateway && !delivery) delivery = gateway.deliverPending().finally(() => { delivery = undefined; });
      if (management && !evaluation && !stopping) evaluation = management.runNextEvaluation(routingController.signal).catch(error => console.error('经验评估未完成', String(error))).finally(() => { evaluation = undefined; });
    };
    inboxTimer = setInterval(receive, 700);
    receive();
    console.info(useFeishu ? '服务已启动：飞书长连接 + 单任务执行队列' : '本地执行队列已启动');
    if (!stopping) await onReady?.();
    while (!stopping) {
      const advanced = await service.runNext();
      if (once && !advanced) { await routing; if (!service.store.tasks('queued').length && !service.store.pendingMessages().length) break; }
      if (!advanced) await sleep(300);
    }
    if (transportFailure) throw transportFailure;
  } finally {
    clearInterval(inboxTimer);
    routingController.abort(new Error('服务停止'));
    service.health.worker = 'stopping'; service.health.feishu = transportFailure ? 'failed' : 'disconnected';
    try { await routing; await delivery; await evaluation; await gateway?.disconnect(); await admin?.close(); }
    finally { service.health.worker = 'stopped'; process.off('SIGINT', stop); process.off('SIGTERM', stop); await release(); }
  }
}
