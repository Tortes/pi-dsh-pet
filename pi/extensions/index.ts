import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Server as HttpServer, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const PI_DIR = dirname(dirname(__filename));
const PACKAGE_ROOT = dirname(PI_DIR);
const PET_ASSETS = join(PACKAGE_ROOT, 'dsh-pet', 'assets');

const MIME: Record<string, string> = {
  '.jsonc': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
};

let port = 0;
let server: HttpServer | null = null;
let closeWebSockets: (() => void) | null = null;
let broadcast: ((message: string) => void) | null = null;
let petProcess: ChildProcess | null = null;
let petConnected = false;
let petEverConnected = false;
let petDesired = false;
let stopping = false;
let petSize = 'normal';
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let waitingTimer: ReturnType<typeof setTimeout> | null = null;
let turnHadError = false;
let connectionWaiters = new Set<() => void>();

const SIZE_MAP: Record<string, number> = { small: 260, normal: 400, large: 540 };
const MAX_RESTART_ATTEMPTS = 5;

function safeAsset(root: string, rel: string): string | undefined {
  if (!rel || rel.includes('..')) return undefined;
  const candidate = normalize(join(root, rel));
  if (!candidate.startsWith(root)) return undefined;
  return candidate;
}

async function sendFile(res: ServerResponse, file: string): Promise<void> {
  try {
    const info = await stat(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function startServer(): Promise<number> {
  if (server?.listening) return port;

  const srv = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);

    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port }));
      return;
    }
    if (pathname === '/config.jsonc') {
      await sendFile(res, join(PET_ASSETS, 'config.jsonc'));
      return;
    }
    if (pathname.startsWith('/webm/')) {
      const file = safeAsset(join(PET_ASSETS, 'webm'), pathname.slice('/webm/'.length));
      if (!file) {
        res.writeHead(400);
        res.end('Bad path');
        return;
      }
      await sendFile(res, file);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const WebSocketServer = (await import('ws')).WebSocketServer;
  const wsServer = new WebSocketServer({ noServer: true });
  const clients = new Set<import('ws').WebSocket>();

  wsServer.on('connection', (ws) => {
    clients.add(ws);
    petConnected = true;
    petEverConnected = true;
    restartAttempts = 0;
    for (const resolve of connectionWaiters) resolve();
    connectionWaiters.clear();

    ws.on('message', (data) => {
      if (data.toString() === 'ping' && ws.readyState === ws.OPEN) ws.send('pong');
    });
    ws.on('close', () => {
      clients.delete(ws);
      petConnected = clients.size > 0;
    });
    ws.on('error', () => {
      clients.delete(ws);
      petConnected = clients.size > 0;
    });
  });

  srv.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
  });

  for (let i = 0; i < 20; i++) {
    const candidate = randomInt(10240, 49152);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          srv.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          srv.removeListener('error', onError);
          resolve();
        };
        srv.once('error', onError);
        srv.once('listening', onListening);
        srv.listen(candidate, '127.0.0.1');
      });
      port = candidate;
      server = srv;
      broadcast = (message) => {
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) ws.send(message);
        }
      };
      closeWebSockets = () => {
        for (const ws of clients) ws.close(1001, 'Pi pet host shutting down');
        wsServer.close();
      };
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }

  throw new Error('could not find a free pet port');
}

function stopServer(): void {
  broadcast?.('shutdown');
  closeWebSockets?.();
  closeWebSockets = null;
  server?.close();
  server = null;
  broadcast = null;
  port = 0;
  petConnected = false;
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function findPetExecutable(): string {
  if (process.env.PI_DSH_PET_BIN) return process.env.PI_DSH_PET_BIN;
  const windowsRuntime = process.platform === 'win32' || isWsl();
  const binary = windowsRuntime ? 'pi-dsh-pet.exe' : 'pi-dsh-pet';
  const candidates = [
    join(PACKAGE_ROOT, 'pi', 'bin', binary),
    join(PACKAGE_ROOT, 'src-tauri', 'target', 'release', binary),
    join(PACKAGE_ROOT, 'src-tauri', 'target', 'debug', binary),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function broadcastStatus(state: 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error'): void {
  broadcast?.(JSON.stringify({ type: 'work_status', state }));
}

function scheduleRestart(): void {
  if (!petDesired || stopping || restartTimer) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    petDesired = false;
    console.error('[pi-dsh-pet] runtime restart limit reached; use /pet to start it again');
    return;
  }

  const delay = Math.min(500 * (2 ** restartAttempts), 8000);
  restartAttempts += 1;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    try {
      await launchPet(petSize);
      await waitForPetConnection(12000);
      console.info('[pi-dsh-pet] Windows runtime recovered');
    } catch (error) {
      console.error('[pi-dsh-pet] runtime recovery attempt failed:', String(error));
      scheduleRestart();
    }
  }, delay);
}

function launchPet(size: string): Promise<void> {
  if (petProcess && petProcess.exitCode === null) return Promise.resolve();

  const exe = findPetExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [String(port), size], {
      cwd: PACKAGE_ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    petProcess = child;

    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (err) => {
      if (petProcess === child) petProcess = null;
      reject(new Error(`Unable to start desktop pet at "${exe}": ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      if (petProcess === child) petProcess = null;
      petConnected = false;
      if (code !== 0 && code !== null) {
        console.error(`[pi-dsh-pet] runtime exited (code=${code}, signal=${signal})`);
      }
      if (petDesired && petEverConnected && !stopping) scheduleRestart();
    });
  });
}

async function waitForPetConnection(timeoutMs = 15000): Promise<void> {
  if (petConnected) return;
  const child = petProcess;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      connectionWaiters.delete(onConnected);
      child?.removeListener('exit', onExit);
    };
    const onConnected = () => {
      cleanup();
      resolve();
    };
    const onExit = () => {
      cleanup();
      reject(new Error('Windows pet exited before connecting to Pi'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Windows pet started but did not connect to Pi. Check WSL localhost forwarding and Windows Firewall.'));
    }, timeoutMs);
    connectionWaiters.add(onConnected);
    child?.once('exit', onExit);
  });
}

async function stopPet(): Promise<void> {
  petDesired = false;
  petEverConnected = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;

  const child = petProcess;
  if (!child || child.exitCode !== null) {
    petProcess = null;
    petConnected = false;
    return;
  }

  broadcast?.('shutdown');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1200);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (isWsl()) {
      spawn('taskkill.exe', ['/im', 'pi-dsh-pet.exe', '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill();
    }
  }
  if (petProcess === child) petProcess = null;
  petConnected = false;
}

async function shutdown(): Promise<void> {
  stopping = true;
  if (waitingTimer) clearTimeout(waitingTimer);
  waitingTimer = null;
  await stopPet();
  stopServer();
}

export default function (pi: ExtensionAPI) {
  process.once('exit', () => {
    petDesired = false;
    broadcast?.('shutdown');
    closeWebSockets?.();
    server?.close();
  });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  pi.on('session_start', async (_event, ctx) => {
    try {
      await startServer();
    } catch (error) {
      ctx.ui.notify('pet server start failed: ' + String(error), 'error');
    }
  });

  pi.on('session_shutdown', async () => {
    await shutdown();
  });

  pi.on('agent_start', () => {
    turnHadError = false;
    broadcastStatus('thinking');
  });

  pi.on('turn_start', () => broadcastStatus('thinking'));

  // A tool request may pause for approval; show waiting only if execution does not start immediately.
  pi.on('tool_call', () => {
    if (waitingTimer) clearTimeout(waitingTimer);
    waitingTimer = setTimeout(() => {
      waitingTimer = null;
      broadcastStatus('waiting');
    }, 400);
  });

  pi.on('tool_execution_start', () => {
    if (waitingTimer) clearTimeout(waitingTimer);
    waitingTimer = null;
    broadcastStatus('working');
  });

  pi.on('tool_execution_end', (event) => {
    if (event.isError) turnHadError = true;
    broadcastStatus(event.isError ? 'error' : 'result');
  });

  pi.on('agent_end', (event) => {
    if (waitingTimer) clearTimeout(waitingTimer);
    waitingTimer = null;
    const messages = (event as { messages?: Array<{ role?: string; stopReason?: string }> }).messages ?? [];
    const messageError = messages.some((message) =>
      message.role === 'assistant' && ['error', 'aborted', 'length'].includes(message.stopReason ?? ''),
    );
    broadcastStatus(turnHadError || messageError ? 'error' : 'success');
  });

  pi.registerCommand('pet', {
    description: 'Open the Tauri desktop pet',
    getArgumentCompletions: (prefix) =>
      Object.keys(SIZE_MAP)
        .filter((size) => size.startsWith(prefix))
        .map((size) => ({ value: size, label: size + ' (' + SIZE_MAP[size] + 'px)' })),
    handler: async (args, ctx) => {
      try {
        await startServer();
        const requested = (args ?? '').trim().toLowerCase();
        const size = requested in SIZE_MAP ? requested : 'normal';
        petSize = size;
        petDesired = true;
        stopping = false;
        if (!petConnected) petEverConnected = false;
        restartAttempts = 0;
        await launchPet(size);
        await waitForPetConnection();
        ctx.ui.notify('Windows desktop pet is running (' + size + ')', 'info');
      } catch (error) {
        await stopPet();
        ctx.ui.notify('pet start failed: ' + String(error), 'error');
      }
    },
  });

  pi.registerCommand('pet-status', {
    description: 'Check whether the Windows desktop pet is connected',
    handler: async (_args, ctx) => {
      ctx.ui.notify(petConnected ? 'Pet is connected' : 'Pet is not running', 'info');
    },
  });

  pi.registerCommand('pet-stop', {
    description: 'Close the Tauri desktop pet',
    handler: async (_args, ctx) => {
      await stopPet();
      ctx.ui.notify('Pet closed', 'info');
    },
  });
}
