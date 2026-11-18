import { invoke } from '@tauri-apps/api/core';

const runtime = await invoke('runtime_config');
const port = Number(runtime.port);
const requestedSize = Number(runtime.size);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid Pi pet server port. Start the pet with the Pi /pet command.');
}

const root = document.querySelector('#pet-root');
const pet = document.createElement('div');
pet.className = 'pet';
pet.style.width = requestedSize + 'px';
root.appendChild(pet);

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
video.autoplay = true;
pet.appendChild(video);

let config = null;
let current = '';
let socket = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectStartedAt = 0;
let reconnectAttempts = 0;
let lastPong = 0;
let shuttingDown = false;

const WORK_STATUS_INDEX = {
  thinking: 0,
  working: 1,
  result: 2,
  waiting: 3,
  success: 4,
  error: 5,
};

function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pickSlot(slot) {
  const candidates = Array.isArray(slot) ? slot.filter(value => typeof value === 'string' && value) : [slot];
  if (candidates.length === 0) return null;
  const distinct = candidates.filter(value => value !== current);
  return pick(distinct.length ? distinct : candidates);
}

async function loadConfig() {
  const response = await fetch('http://127.0.0.1:' + port + '/config.jsonc');
  if (!response.ok) throw new Error('Pi asset server returned HTTP ' + response.status);
  config = JSON.parse(stripJsonc(await response.text()));

  const idle = config?.animations?.idle;
  if (!Array.isArray(idle) || idle.length === 0) {
    throw new Error('No idle animations found in dsh-pet/assets/config.jsonc');
  }

  const physics = config.physics ?? {};
  await invoke('set_physics', {
    physics: {
      gravity: Number(physics.gravity ?? 1400),
      restitution: Number(physics.restitution ?? 0.78),
      groundFriction: Number(physics.groundFriction ?? 2.5),
      ceilingBounce: physics.ceilingBounce !== false,
      throwPower: Number(physics.throwPower ?? 1),
    },
  });
  play(pick(idle), true);
}

function animationUrl(name) {
  return 'http://127.0.0.1:' + port + '/webm/' + encodeURIComponent(name) + '.webm';
}

function play(name, loop = false) {
  if (!name) return;
  if (name === current && video.src && video.loop === loop) return;
  current = name;
  video.onended = null;
  video.onerror = () => {
    console.warn('[pi-dsh-pet] animation asset failed:', name);
    const idle = config?.animations?.idle;
    if (Array.isArray(idle) && idle.length && !idle.includes(name)) play(pick(idle), true);
  };
  video.loop = loop;
  video.src = animationUrl(name);
  if (!loop) {
    video.onended = () => {
      const idle = config?.animations?.idle;
      if (Array.isArray(idle) && idle.length) play(pick(idle), true);
    };
  }
  video.play().catch(error => console.error('[pi-dsh-pet] video playback failed:', error));
}

function playWorkStatus(state) {
  const index = WORK_STATUS_INDEX[state];
  const pool = config?.animations?.events?.workStatus;
  if (index === undefined || !Array.isArray(pool) || pool[index] === undefined) {
    console.warn('[pi-dsh-pet] missing configured workStatus animation for:', state);
    return;
  }
  const animation = pickSlot(pool[index]);
  const looping = state === 'thinking' || state === 'working' || state === 'waiting';
  play(animation, looping);
}

function handleMessage(raw) {
  if (raw === 'shutdown') {
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    invoke('close_pet').catch(() => {});
    return;
  }

  if (raw === 'pong') return;
  if (raw === 'agent_idle') {
    const idle = config?.animations?.idle;
    if (Array.isArray(idle) && idle.length) play(pick(idle), true);
    return;
  }
  if (raw.startsWith('{')) {
    try {
      const event = JSON.parse(raw);
      if (event.type === 'work_status') playWorkStatus(event.state);
    } catch (error) {
      console.warn('[pi-dsh-pet] invalid event:', error);
    }
  }
}

let lastBounds = '';
async function syncBounds() {
  const rect = pet.getBoundingClientRect();
  const bounds = JSON.stringify({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
  if (bounds === lastBounds) return;
  await invoke('set_pet_bounds', {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
  lastBounds = bounds;
}

function connect() {
  if (shuttingDown) return;
  socket = new WebSocket('ws://127.0.0.1:' + port + '/ws');

  socket.onopen = () => {
    reconnectAttempts = 0;
    reconnectStartedAt = 0;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 8000) {
        socket.close();
        return;
      }
      socket.send('ping');
    }, 2000);
    lastPong = Date.now();
  };

  socket.onmessage = event => {
    const raw = String(event.data);
    if (raw === 'pong') {
      lastPong = Date.now();
      return;
    }
    handleMessage(raw);
  };

  socket.onerror = error => console.warn('[pi-dsh-pet] WebSocket connection error:', error);
  socket.onclose = () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (shuttingDown) return;
    if (!reconnectStartedAt) reconnectStartedAt = Date.now();
    if (Date.now() - reconnectStartedAt > 15000) {
      console.error('[pi-dsh-pet] Pi host heartbeat lost; closing orphaned pet runtime');
      shuttingDown = true;
      invoke('close_pet').catch(() => {});
      return;
    }
    const delay = Math.min(500 * (2 ** reconnectAttempts), 4000);
    reconnectAttempts += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };
}

try {
  await loadConfig();
  await syncBounds();
  setInterval(() => { void syncBounds(); }, 250);
  connect();
  await invoke('show_pet');
} catch (error) {
  console.error('[pi-dsh-pet] startup failed:', error);
  throw error;
}
