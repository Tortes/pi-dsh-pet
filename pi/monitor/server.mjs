import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(dirname(__dirname));
const PET_ASSETS = join(PACKAGE_ROOT, 'dsh-pet', 'assets');
const PORT = Number(process.env.PI_DSH_PET_PORT || 39471);
const AGENT_TTL_MS = 16000;
const IDLE_EXIT_MS = 20000;
const TERMINAL_VISIBLE_MS = 9000;
const MAX_RESTART_ATTEMPTS = 5;
const SIZE_MAP = { small: 260, normal: 400, large: 540 };
const MIME = { '.jsonc': 'application/json; charset=utf-8', '.webm': 'video/webm' };
const STATUS_PRIORITY = { waiting: 60, working: 50, thinking: 40, error: 30, result: 20, success: 10, idle: 0 };
const VALID_STATES = new Set(Object.keys(STATUS_PRIORITY));

const agents = new Map();
const clients = new Set();
const connectionWaiters = new Set();
let server;
let petProcess = null;
let petConnected = false;
let petEverConnected = false;
let petDesired = false;
let petSize = 'normal';
let restartAttempts = 0;
let restartTimer = null;
let connectionLostTimer = null;
let idleExitTimer = null;
let lastSnapshotSignature = '';

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function safeText(value, max = 180) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 32768) throw new Error('request body too large');
  }
  return body ? JSON.parse(body) : {};
}

async function sendFile(res, file) {
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

function safeAsset(root, relative) {
  if (!relative || relative.includes('\0')) return undefined;
  const candidate = resolve(root, normalize(relative));
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  return candidate;
}

function agentView(agent) {
  return {
    id: agent.id,
    pid: agent.pid,
    project: agent.project,
    cwd: agent.cwd,
    state: agent.state,
    task: agent.task,
    eventType: agent.eventType,
    updatedAt: agent.updatedAt,
  };
}

function currentAggregate(now = Date.now()) {
  const list = [...agents.values()];
  const active = list.filter((agent) => ['waiting', 'working', 'thinking'].includes(agent.state));
  const candidates = active.length
    ? active
    : list.filter((agent) =>
        ['error', 'result', 'success'].includes(agent.state) && now - agent.updatedAt <= TERMINAL_VISIBLE_MS,
      );
  candidates.sort((a, b) => {
    if (active.length && STATUS_PRIORITY[b.state] !== STATUS_PRIORITY[a.state]) {
      return STATUS_PRIORITY[b.state] - STATUS_PRIORITY[a.state];
    }
    return b.updatedAt - a.updatedAt;
  });
  const selected = candidates[0];
  return selected ? { state: selected.state, agent: agentView(selected) } : null;
}

function snapshot() {
  const ordered = [...agents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const list = ordered.map(agentView);
  const latest = ordered.find((agent) =>
    agent.state !== 'idle' &&
    (!['error', 'result', 'success'].includes(agent.state) ||
      Date.now() - agent.updatedAt <= TERMINAL_VISIBLE_MS),
  );
  return {
    type: 'agents_snapshot',
    agents: list,
    latest: latest ? agentView(latest) : null,
    aggregate: currentAggregate(),
  };
}

function broadcastSnapshot(force = false) {
  const data = snapshot();
  const signature = JSON.stringify(data);
  if (!force && signature === lastSnapshotSignature) return;
  lastSnapshotSignature = signature;
  const message = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

function clearIdleExit() {
  if (idleExitTimer) clearTimeout(idleExitTimer);
  idleExitTimer = null;
}

function scheduleIdleExit() {
  if (agents.size > 0 || idleExitTimer) return;
  idleExitTimer = setTimeout(async () => {
    idleExitTimer = null;
    if (agents.size > 0) return;
    await stopPet();
    server?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref?.();
  }, IDLE_EXIT_MS);
  idleExitTimer.unref?.();
}

function upsertAgent(input, event = false) {
  const id = safeText(input.id, 100);
  if (!id) throw new Error('agent id is required');
  const now = Date.now();
  const previous = agents.get(id);
  const rawState = input.state;
  const state = VALID_STATES.has(rawState) ? rawState : previous?.state ?? 'idle';
  const task = input.task === null ? null : safeText(input.task, 120) || null;
  const stateChanged = !previous || previous.state !== state || previous.task !== task;
  const agent = {
    id,
    pid: Number.isInteger(input.pid) ? input.pid : previous?.pid ?? 0,
    project: safeText(input.project, 80) || previous?.project || 'Pi',
    cwd: safeText(input.cwd, 500) || previous?.cwd || '',
    state,
    task,
    eventType: event ? safeText(input.eventType, 80) : previous?.eventType ?? 'session_start',
    registeredAt: previous?.registeredAt ?? now,
    lastSeen: now,
    updatedAt: event || stateChanged ? now : previous?.updatedAt ?? now,
  };
  agents.set(id, agent);
  clearIdleExit();
  return agent;
}

function pruneAgents() {
  const now = Date.now();
  let changed = false;
  for (const [id, agent] of agents) {
    if (now - agent.lastSeen > AGENT_TTL_MS) {
      agents.delete(id);
      changed = true;
    }
  }
  if (changed) {
    broadcastSnapshot();
    if (agents.size === 0) scheduleIdleExit();
  }
  // Terminal animations return to idle after a short display window.
  broadcastSnapshot();
}

function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function findPetExecutable() {
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

function forceKillRuntime(child) {
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

function scheduleRestart() {
  if (!petDesired || restartTimer) return;
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
      await launchPet();
      await waitForPetConnection(12000);
      console.info('[pi-dsh-pet] runtime recovered');
    } catch (error) {
      console.error('[pi-dsh-pet] runtime recovery failed:', String(error));
      const failedChild = petProcess;
      if (failedChild && failedChild.exitCode === null) {
        forceKillRuntime(failedChild);
        petProcess = null;
        petConnected = false;
      }
      scheduleRestart();
    }
  }, delay);
  restartTimer.unref?.();
}

function scheduleConnectionRecovery() {
  if (!petDesired || connectionLostTimer) return;
  connectionLostTimer = setTimeout(() => {
    connectionLostTimer = null;
    if (petConnected || !petDesired) return;
    const staleChild = petProcess;
    if (staleChild && staleChild.exitCode === null) {
      forceKillRuntime(staleChild);
      if (petProcess === staleChild) petProcess = null;
    }
    scheduleRestart();
  }, 18000);
  connectionLostTimer.unref?.();
}

function launchPet() {
  if (petProcess && petProcess.exitCode === null) return Promise.resolve();
  const exe = findPetExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [String(PORT), petSize], {
      cwd: PACKAGE_ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    petProcess = child;
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (error) => {
      if (petProcess === child) petProcess = null;
      reject(new Error('Unable to start desktop pet at "' + exe + '": ' + error.message));
    });
    child.once('exit', (code, signal) => {
      if (petProcess === child) petProcess = null;
      petConnected = false;
      if (code !== 0 && code !== null) {
        console.error('[pi-dsh-pet] runtime exited (code=' + code + ', signal=' + signal + ')');
      }
      if (petDesired && petEverConnected) scheduleRestart();
    });
  });
}

async function waitForPetConnection(timeoutMs = 15000) {
  if (petConnected) return;
  const child = petProcess;
  await new Promise((resolve, reject) => {
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
      reject(new Error('Windows pet exited before connecting to Pi monitor'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Windows pet started but did not connect to Pi monitor'));
    }, timeoutMs);
    connectionWaiters.add(onConnected);
    child?.once('exit', onExit);
  });
}

async function startPet(size) {
  if (!agents.size) throw new Error('No Pi processes are registered yet');
  petSize = SIZE_MAP[size] ? size : 'normal';
  petDesired = true;
  petEverConnected = petConnected || petEverConnected;
  restartAttempts = 0;
  await launchPet();
  await waitForPetConnection();
  return { ok: true, connected: petConnected, size: petSize };
}

async function stopPet() {
  petDesired = false;
  petEverConnected = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  if (connectionLostTimer) clearTimeout(connectionLostTimer);
  connectionLostTimer = null;

  const child = petProcess;
  if (!child || child.exitCode !== null) {
    petProcess = null;
    petConnected = false;
    return;
  }
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send('shutdown');
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1200);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (child.exitCode === null) forceKillRuntime(child);
  if (petProcess === child) petProcess = null;
  petConnected = false;
}

const wsServer = new WebSocketServer({ noServer: true });
const lastPing = new WeakMap();

wsServer.on('connection', (ws) => {
  clients.add(ws);
  petConnected = true;
  petEverConnected = true;
  for (const resolve of connectionWaiters) resolve();
  connectionWaiters.clear();
  if (connectionLostTimer) clearTimeout(connectionLostTimer);
  connectionLostTimer = null;
  ws.send(JSON.stringify(snapshot()));
  ws.on('message', (data) => {
    if (data.toString() === 'ping') {
      lastPing.set(ws, Date.now());
      if (ws.readyState === ws.OPEN) ws.send('pong');
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    petConnected = clients.size > 0;
    if (!petConnected) scheduleConnectionRecovery();
  });
  ws.on('error', () => {
    clients.delete(ws);
    petConnected = clients.size > 0;
    if (!petConnected) scheduleConnectionRecovery();
  });
});

const heartbeatWatchdog = setInterval(() => {
  const now = Date.now();
  for (const ws of clients) {
    if (now - (lastPing.get(ws) ?? now) > 10000) ws.terminate();
  }
}, 5000);
heartbeatWatchdog.unref?.();

server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  try {
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        version: 1,
        port: PORT,
        agents: agents.size,
        petConnected,
        petDesired,
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/agents') {
      sendJson(res, 200, { agents: snapshot().agents, petConnected, petDesired });
      return;
    }
    if (req.method === 'GET' && pathname === '/config.jsonc') {
      await sendFile(res, join(PET_ASSETS, 'config.jsonc'));
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/webm/')) {
      const relative = decodeURIComponent(pathname.slice('/webm/'.length));
      const file = safeAsset(join(PET_ASSETS, 'webm'), relative);
      if (!file) {
        res.writeHead(400);
        res.end('Bad path');
        return;
      }
      await sendFile(res, file);
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (pathname === '/agents/register') {
        upsertAgent(body);
        broadcastSnapshot();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/agents/heartbeat') {
        upsertAgent(body);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/agents/event') {
        upsertAgent(body, true);
        broadcastSnapshot();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/agents/unregister') {
        const id = safeText(body.id, 100);
        if (id) agents.delete(id);
        broadcastSnapshot();
        if (agents.size === 0) scheduleIdleExit();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/pet/start') {
        const result = await startPet(safeText(body.size, 20));
        sendJson(res, 200, result);
        return;
      }
      if (pathname === '/pet/stop') {
        await stopPet();
        sendJson(res, 200, { ok: true, connected: false });
        return;
      }
    }
    sendJson(res, 404, { ok: false, message: 'not found' });
  } catch (error) {
    sendJson(res, 400, { ok: false, message: safeText(String(error), 240) || 'bad request' });
  }
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') process.exit(0);
  console.error('[pi-dsh-pet] monitor server error:', error);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.info('[pi-dsh-pet] multi-agent monitor listening on 127.0.0.1:' + PORT);
  scheduleIdleExit();
});

const sweepTimer = setInterval(pruneAgents, 2000);
sweepTimer.unref?.();

async function shutdown() {
  clearInterval(sweepTimer);
  clearInterval(heartbeatWatchdog);
  clearIdleExit();
  await stopPet();
  for (const ws of clients) ws.close(1001, 'Pi monitor shutting down');
  wsServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
