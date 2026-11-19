import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const directory = new URL('.', import.meta.url);
const serverFile = fileURLToPath(new URL('./server.mjs', directory));
const port = randomInt(42000, 60000);
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, [serverFile], {
  env: { ...process.env, PI_DSH_PET_PORT: String(port) },
  stdio: 'ignore',
  windowsHide: true,
});

const queue = [];
const waiters = [];
let socket;

function nextSnapshot(timeoutMs = 3000) {
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for monitor snapshot')), timeoutMs);
    waiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(500) });
      if (response.ok) return response.json();
    } catch {
      /* The detached monitor has not bound its port yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('monitor did not start');
}

async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, path + ' should return HTTP 200');
  return response.json();
}

try {
  const health = await waitForHealth();
  assert.equal(health.service, 'pi-dsh-pet-monitor');
  assert.equal(health.version, 1);

  socket = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  socket.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    const resolve = waiters.shift();
    if (resolve) resolve(value);
    else queue.push(value);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const initial = await nextSnapshot();
  assert.deepEqual(initial.agents, []);

  const agent = {
    id: 'smoke-agent',
    pid: 12345,
    project: 'smoke-project',
    cwd: '/tmp/smoke-project',
    state: 'idle',
    task: null,
    eventType: 'session_start',
  };
  await post('/agents/register', agent);
  const registered = await nextSnapshot();
  assert.equal(registered.agents.length, 1);
  assert.equal(registered.agents[0].pid, 12345);

  await post('/agents/event', {
    ...agent,
    state: 'working',
    task: 'bash · git status',
    eventType: 'tool_execution_start',
  });
  const progress = await nextSnapshot();
  assert.equal(progress.latest.state, 'working');
  assert.equal(progress.latest.task, 'bash · git status');
  assert.equal(progress.aggregate.state, 'working');
  assert.equal(progress.activeCount, 1);

  const query = await (await fetch(base + '/agents')).json();
  assert.equal(query.agents.length, 1);
  assert.equal(query.agents[0].state, 'working');

  await post('/agents/unregister', { id: 'smoke-agent' });
  const removed = await nextSnapshot();
  assert.equal(removed.agents.length, 0);

  console.log('Pi multi-agent monitor smoke test passed');
} finally {
  socket?.close();
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
