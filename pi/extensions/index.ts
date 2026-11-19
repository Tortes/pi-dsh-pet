import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PI_DIR = dirname(dirname(__filename));
const PACKAGE_ROOT = dirname(PI_DIR);
const MONITOR_SERVER = join(PI_DIR, 'monitor', 'server.mjs');
const MONITOR_PORT = Number(process.env.PI_DSH_PET_PORT || 39471);
const MONITOR_URL = 'http://127.0.0.1:' + MONITOR_PORT;
const AGENT_ID = String(process.pid) + '-' + randomUUID();
const PROJECT = basename(process.cwd()) || 'Pi';
const PROCESS_INFO = {
  id: AGENT_ID,
  pid: process.pid,
  project: PROJECT,
  cwd: process.cwd(),
  startedAt: Date.now(),
};

const SIZE_MAP: Record<string, number> = { small: 260, normal: 400, large: 540 };
const STATUS_LABELS: Record<string, string> = {
  idle: '空闲',
  thinking: '思考中',
  working: '执行中',
  result: '整理结果',
  waiting: '等待确认',
  success: '已完成',
  error: '发生错误',
};

type AgentState = 'idle' | 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error';

let agentState: AgentState = 'idle';
let agentTask: string | null = null;
let agentEventType = 'session_start';
let agentRegistered = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let waitingTimer: ReturnType<typeof setTimeout> | null = null;
let turnHadError = false;
let lastMonitorWarning = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function monitorRequest(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(MONITOR_URL + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.message ?? 'monitor HTTP ' + response.status));
  }
  return data;
}

/** Start one detached local monitor if none is listening; concurrent Pi processes race on one loopback port. */
async function ensureMonitor(): Promise<any> {
  try {
    const health = await monitorRequest('/health');
    if (health.version === 1) return health;
  } catch {
    /* No monitor yet (or it is restarting). */
  }

  try {
    const child = spawn(process.execPath, [MONITOR_SERVER], {
      cwd: PACKAGE_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PI_DSH_PET_PORT: String(MONITOR_PORT) },
    });
    child.once('error', () => {});
    child.unref();
  } catch {
    /* Another Pi process may win the bind race; the health check below decides. */
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await delay(200);
    try {
      const health = await monitorRequest('/health');
      if (health.version === 1) return health;
    } catch {
      /* Keep waiting for the detached monitor to bind. */
    }
  }
  throw new Error('Unable to start the shared Pi monitor on 127.0.0.1:' + MONITOR_PORT);
}

function agentPayload() {
  return {
    ...PROCESS_INFO,
    state: agentState,
    task: agentTask,
    eventType: agentEventType,
  };
}

async function registerAgent(): Promise<void> {
  await ensureMonitor();
  await monitorRequest('/agents/register', 'POST', agentPayload());
  agentRegistered = true;
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      void sendHeartbeat();
    }, 5000);
    heartbeatTimer.unref?.();
  }
}

async function sendHeartbeat(): Promise<void> {
  try {
    await ensureMonitor();
    await monitorRequest(
      agentRegistered ? '/agents/heartbeat' : '/agents/register',
      'POST',
      agentPayload(),
    );
    agentRegistered = true;
  } catch (error) {
    const now = Date.now();
    if (now - lastMonitorWarning > 30000) {
      lastMonitorWarning = now;
      console.warn('[pi-dsh-pet] shared monitor heartbeat failed:', String(error));
    }
    agentRegistered = false;
  }
}

function reportProgress(state: AgentState, task: string | null, eventType: string): void {
  agentState = state;
  agentTask = task;
  agentEventType = eventType;
  void (async () => {
    try {
      await ensureMonitor();
      if (!agentRegistered) await registerAgent();
      await monitorRequest('/agents/event', 'POST', agentPayload());
    } catch (error) {
      const now = Date.now();
      if (now - lastMonitorWarning > 30000) {
        lastMonitorWarning = now;
        console.warn('[pi-dsh-pet] unable to report Pi progress:', String(error));
      }
    }
  })();
}

function toolTask(event: unknown): string {
  const value = (event ?? {}) as Record<string, any>;
  const tool = value.toolName ?? value.name ?? value.tool?.name ?? value.toolCall?.name;
  const name = typeof tool === 'string' && tool ? tool : '工具';
  const args = value.args ?? value.input ?? value.arguments ?? value.tool?.arguments ?? value.toolCall?.arguments;
  if (args && typeof args === 'object') {
    const target = args.path ?? args.filePath ?? args.file_path ?? args.filename;
    if (typeof target === 'string' && target) return name + ' · ' + basename(target);
  }
  return name;
}

function formatAgent(agent: {
  pid?: number;
  project?: string;
  state?: string;
  task?: string | null;
}): string {
  const status = STATUS_LABELS[agent.state ?? 'idle'] ?? agent.state ?? '未知';
  return 'PID ' + String(agent.pid ?? '?') + ' · ' + String(agent.project ?? 'Pi') +
    ' · ' + status + (agent.task ? ' · ' + agent.task : '');
}

async function getMonitorSnapshot(): Promise<{ agents: any[]; petConnected: boolean; petDesired: boolean }> {
  await ensureMonitor();
  if (!agentRegistered) await registerAgent();
  return monitorRequest('/agents');
}

function clearLocalTimers(): void {
  if (waitingTimer) clearTimeout(waitingTimer);
  waitingTimer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function unregisterAgent(): Promise<void> {
  clearLocalTimers();
  if (!agentRegistered) return;
  agentRegistered = false;
  try {
    await monitorRequest('/agents/unregister', 'POST', { id: AGENT_ID });
  } catch {
    /* The monitor may already have exited after the last Pi process closed. */
  }
}

export default function (pi: ExtensionAPI) {
  process.once('exit', clearLocalTimers);

  pi.on('session_start', async (_event, ctx) => {
    try {
      await registerAgent();
    } catch (error) {
      ctx.ui.notify('Pi multi-process monitor failed: ' + String(error), 'error');
    }
  });

  pi.on('session_shutdown', async () => {
    await unregisterAgent();
  });

  pi.on('agent_start', () => {
    turnHadError = false;
    reportProgress('thinking', null, 'agent_start');
  });

  pi.on('turn_start', () => {
    turnHadError = false;
    reportProgress('thinking', null, 'turn_start');
  });

  // A tool request may pause for approval; report waiting only if execution does not start immediately.
  pi.on('tool_call', (event) => {
    if (waitingTimer) clearTimeout(waitingTimer);
    const task = toolTask(event);
    waitingTimer = setTimeout(() => {
      waitingTimer = null;
      reportProgress('waiting', task, 'tool_call');
    }, 400);
  });

  pi.on('tool_execution_start', (event) => {
    if (waitingTimer) clearTimeout(waitingTimer);
    waitingTimer = null;
    reportProgress('working', toolTask(event), 'tool_execution_start');
  });

  pi.on('tool_execution_end', (event) => {
    if (event.isError) turnHadError = true;
    reportProgress(event.isError ? 'error' : 'result', agentTask, 'tool_execution_end');
  });

  pi.on('agent_end', (event) => {
    if (waitingTimer) clearTimeout(waitingTimer);
    waitingTimer = null;
    const messages = (event as { messages?: Array<{ role?: string; stopReason?: string }> }).messages ?? [];
    const messageError = messages.some((message) =>
      message.role === 'assistant' && ['error', 'aborted', 'length'].includes(message.stopReason ?? ''),
    );
    reportProgress(turnHadError || messageError ? 'error' : 'success', null, 'agent_end');
  });

  pi.registerCommand('pet', {
    description: 'Open the shared multi-Pi desktop pet',
    getArgumentCompletions: (prefix) =>
      Object.keys(SIZE_MAP)
        .filter((size) => size.startsWith(prefix))
        .map((size) => ({ value: size, label: size + ' (' + SIZE_MAP[size] + 'px)' })),
    handler: async (args, ctx) => {
      try {
        await registerAgent();
        const requested = (args ?? '').trim().toLowerCase();
        const size = requested in SIZE_MAP ? requested : 'normal';
        await monitorRequest('/pet/start', 'POST', { size });
        ctx.ui.notify('Shared Pi Pet is running (' + size + ')', 'info');
      } catch (error) {
        ctx.ui.notify('Pet start failed: ' + String(error), 'error');
      }
    },
  });

  pi.registerCommand('pet-status', {
    description: 'Check the shared pet and all registered Pi processes',
    handler: async (_args, ctx) => {
      try {
        const [health, status] = await Promise.all([ensureMonitor(), getMonitorSnapshot()]);
        const lines = status.agents.map(formatAgent);
        ctx.ui.notify(
          'Pet: ' + (health.petConnected ? 'connected' : health.petDesired ? 'starting' : 'stopped') +
          '\nPi processes online: ' + status.agents.length +
          (lines.length ? '\n' + lines.join('\n') : ''),
          'info',
        );
      } catch (error) {
        ctx.ui.notify('Pi monitor unavailable: ' + String(error), 'error');
      }
    },
  });

  pi.registerCommand('pi-status', {
    description: 'List progress for every Pi process connected to the shared monitor',
    handler: async (_args, ctx) => {
      try {
        const status = await getMonitorSnapshot();
        const lines = status.agents.map(formatAgent);
        ctx.ui.notify(
          'Pi processes online: ' + status.agents.length +
          (lines.length ? '\n' + lines.join('\n') : '\nNo Pi process is registered.'),
          'info',
        );
      } catch (error) {
        ctx.ui.notify('Pi monitor unavailable: ' + String(error), 'error');
      }
    },
  });

  pi.registerCommand('pet-stop', {
    description: 'Close the shared multi-Pi desktop pet',
    handler: async (_args, ctx) => {
      try {
        await ensureMonitor();
        await monitorRequest('/pet/stop', 'POST', {});
        ctx.ui.notify('Shared Pi Pet closed', 'info');
      } catch (error) {
        ctx.ui.notify('Pet stop failed: ' + String(error), 'error');
      }
    },
  });
}
