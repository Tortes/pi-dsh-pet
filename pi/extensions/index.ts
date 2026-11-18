import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
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
let broadcast: ((message: string) => void) | null = null;
let petProcess: ChildProcess | null = null;

const SIZE_MAP: Record<string, number> = { small: 260, normal: 400, large: 540 };

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
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
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
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }

  throw new Error('could not find a free pet port');
}

function findPetExecutable(): string {
  if (process.env.PI_DSH_PET_BIN) return process.env.PI_DSH_PET_BIN;
  const binary = process.platform === 'win32' ? 'pi-dsh-pet.exe' : 'pi-dsh-pet';
  const candidates = [
    join(PACKAGE_ROOT, 'pi', 'bin', binary),
    join(PACKAGE_ROOT, 'src-tauri', 'target', 'release', binary),
    join(PACKAGE_ROOT, 'src-tauri', 'target', 'debug', binary),
  ];
  return candidates[0];
}

function launchPet(size: string): void {
  if (petProcess && petProcess.exitCode === null) return;

  const exe = findPetExecutable();
  petProcess = spawn(exe, [String(port), size], {
    cwd: PACKAGE_ROOT,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      PI_DSH_PET_PORT: String(port),
      PI_DSH_PET_SIZE: size,
    },
  });

  petProcess.on('exit', () => { petProcess = null; });
  petProcess.on('error', (err) => {
    console.error('[pi-dsh-pet] failed to launch Tauri pet:', err.message);
    petProcess = null;
  });
  petProcess.unref();
}

function stopPet(): void {
  if (!petProcess || petProcess.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(petProcess.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    petProcess.kill();
  }
  petProcess = null;
}

export default function (pi: ExtensionAPI) {
  let thinkingTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = () => {
    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = null;
    broadcast?.('shutdown');
    stopPet();
    server?.close();
    server = null;
    broadcast = null;
    port = 0;
  };

  process.once('exit', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  pi.on('session_start', async (_event, ctx) => {
    try {
      await startServer();
    } catch (error) {
      ctx.ui.notify('pet server start failed: ' + String(error), 'error');
    }
  });

  pi.on('agent_start', () => broadcast?.('agent_start'));

  pi.on('agent_settled', () => {
    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = null;
    broadcast?.('agent_idle');
  });

  pi.on('turn_start', () => {
    if (thinkingTimer) return;
    broadcast?.('thinking');
    thinkingTimer = setInterval(() => broadcast?.('thinking'), 2000);
  });

  pi.on('tool_call', (event) => {
    broadcast?.(JSON.stringify({ type: 'tool_call', tool: event.toolName }));
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
        launchPet(size);
        ctx.ui.notify('Tauri pet launched (' + size + ')', 'info');
      } catch (error) {
        ctx.ui.notify('pet start failed: ' + String(error), 'error');
      }
    },
  });

  pi.registerCommand('pet-stop', {
    description: 'Close the Tauri desktop pet',
    handler: async (_args, ctx) => {
      stopPet();
      ctx.ui.notify('Pet closed', 'info');
    },
  });
}
