import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const directory = new URL('.', import.meta.url);
const serverFile = fileURLToPath(new URL('./server.mjs', directory));
const port = randomInt(42000, 60000);
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, [serverFile], {
  env: { ...process.env, PI_DSH_PET_PORT: String(port) },
  detached: true, // POSIX Node detached mode creates a new session (setsid).
  stdio: ['ignore', 'ignore', 'ignore'],
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
  assert.equal(health.version, 2);
  assert.equal(health.protocolVersion, 2);
  assert.equal(health.pid, child.pid);
  assert.ok(health.startedAt > 0);

  if (process.platform === 'linux') {
    const stat = await (await import('node:fs/promises')).readFile('/proc/' + child.pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    assert.equal(Number(fields[2]), child.pid, 'detached monitor must own its process group');
    assert.equal(Number(fields[3]), child.pid, 'detached monitor must be a session leader');
  }

  socket = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  socket.on('message', (raw) => {
    const message = raw.toString();
    if (message === 'shutdown' || message === 'pong') return;
    const value = JSON.parse(message);
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

  const secondAgent = {
    id: 'smoke-agent-2',
    pid: 23456,
    project: 'second-project',
    cwd: '/tmp/second-project',
    state: 'idle',
    task: null,
    eventType: 'session_start',
  };
  await post('/agents/register', secondAgent);
  const secondRegistered = await nextSnapshot();
  assert.equal(secondRegistered.agents.length, 2);

  // Pet desired state belongs to explicit owner leases, not a process-global boolean.
  const firstLease = await post('/pet/lease/acquire', { ownerId: agent.id, size: 'small' });
  assert.equal(firstLease.desired, true);
  assert.equal(firstLease.leaseCount, 1);
  const secondLease = await post('/pet/lease/acquire', { ownerId: secondAgent.id, size: 'large' });
  assert.equal(secondLease.leaseCount, 2);
  await post('/pet/lease/release', { ownerId: agent.id });
  const oneLeaseLeft = await (await fetch(base + '/health')).json();
  assert.equal(oneLeaseLeft.petDesired, true);
  assert.equal(oneLeaseLeft.petLeaseCount, 1);

  await post('/pet/stop', { all: true });
  const explicitStop = await (await fetch(base + '/health')).json();
  assert.equal(explicitStop.petDesired, false);
  assert.equal(explicitStop.petLeaseCount, 0);
  await post('/pet/lease/acquire', { ownerId: secondAgent.id, size: 'large' });

  await post('/agents/event', {
    ...agent,
    state: 'working',
    task: 'bash · git status',
    eventType: 'tool_execution_start',
  });
  const firstProgress = await nextSnapshot();
  assert.equal(firstProgress.latest.state, 'working');
  assert.equal(firstProgress.latest.task, 'bash · git status');
  assert.equal(firstProgress.aggregate.state, 'working');
  assert.equal(firstProgress.activeCount, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await post('/agents/event', {
    ...secondAgent,
    state: 'thinking',
    task: null,
    eventType: 'turn_start',
  });
  const secondProgress = await nextSnapshot();
  assert.equal(secondProgress.latest.pid, 23456);
  assert.equal(secondProgress.latest.state, 'thinking');
  assert.equal(secondProgress.activeCount, 2);
  assert.equal(secondProgress.aggregate.state, 'working');

  // A heartbeat must recover an event missed while the Pi process was reconnecting.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await post('/agents/heartbeat', {
    ...agent,
    state: 'success',
    task: null,
    eventType: 'agent_end',
  });
  const recovered = await nextSnapshot();
  assert.equal(recovered.latest.pid, 12345);
  assert.equal(recovered.latest.state, 'success');
  assert.equal(recovered.latest.eventType, 'agent_end');
  assert.equal(recovered.activeCount, 1);

  const query = await (await fetch(base + '/agents')).json();
  assert.equal(query.agents.length, 2);
  assert.equal(query.agents.find((item) => item.pid === 12345).state, 'success');

  await post('/agents/unregister', { id: 'smoke-agent' });
  const firstRemoved = await nextSnapshot();
  assert.equal(firstRemoved.agents.length, 1);
  await post('/agents/unregister', { id: 'smoke-agent-2' });
  const removed = await nextSnapshot();
  assert.equal(removed.agents.length, 0);
  const noLeases = await (await fetch(base + '/health')).json();
  assert.equal(noLeases.petDesired, false);
  assert.equal(noLeases.petLeaseCount, 0);

  console.log('Pi multi-agent monitor smoke test passed');
} finally {
  socket?.close();
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
