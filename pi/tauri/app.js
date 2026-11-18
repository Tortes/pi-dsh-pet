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
let overrideTimer = null;

function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

async function loadConfig() {
  const response = await fetch('http://127.0.0.1:' + port + '/config.jsonc');
  if (!response.ok) {
    throw new Error('Pi asset server returned HTTP ' + response.status);
  }
  config = JSON.parse(stripJsonc(await response.text()));

  const idle = config?.animations?.idle;
  if (!Array.isArray(idle) || idle.length === 0) {
    throw new Error('No idle animations found in dsh-pet/assets/config.jsonc');
  }

  play(pick(idle));
}

function animationUrl(name) {
  return 'http://127.0.0.1:' + port + '/webm/' + encodeURIComponent(name) + '.webm';
}

function play(name, loop = false) {
  if (!name || name === current) return;
  current = name;
  video.loop = loop;
  video.src = animationUrl(name);
  video.play().catch(error => console.error('[pi-dsh-pet] video playback failed:', error));
}

function handleMessage(raw) {
  if (raw === 'shutdown') {
    invoke('close_pet').catch(() => {});
    return;
  }

  let animation = null;
  if (raw === 'agent_start' || raw === 'thinking') {
    animation = '深度思考碎碎念';
  } else if (raw === 'agent_idle') {
    animation = pick(config.animations.idle);
  } else if (raw.startsWith('{')) {
    try {
      const event = JSON.parse(raw);
      if (event.type === 'tool_start') {
        animation = /bash|shell|exec|python|terminal/i.test(event.tool || '')
          ? '写代码'
          : '轻快记录';
      } else if (event.type === 'tool_end') {
        animation = event.error ? '被吓一跳' : '轻快记录';
      }
    } catch (error) {
      console.warn('[pi-dsh-pet] invalid event:', error);
    }
  }

  if (animation) {
    play(animation);
    clearTimeout(overrideTimer);
    if (raw !== 'agent_idle') {
      overrideTimer = setTimeout(() => play(pick(config.animations.idle)), 6000);
    }
  }
}

let lastBounds = '';
setInterval(() => {
  const r = pet.getBoundingClientRect();
  const bounds = JSON.stringify({left:r.left,top:r.top,right:r.right,bottom:r.bottom});
  if (bounds !== lastBounds) {
    lastBounds = bounds;
    invoke('set_pet_bounds', {
      left: r.left, top: r.top, right: r.right, bottom: r.bottom
    }).catch(() => {});
  }
}, 100);

async function connect() {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  ws.onmessage = event => handleMessage(String(event.data));
  ws.onerror = error => console.warn('[pi-dsh-pet] WebSocket connection error:', error);
  ws.onclose = () => setTimeout(connect, 1000);
}

try {
  await loadConfig();
  await connect();
  await invoke('show_pet');
} catch (error) {
  console.error('[pi-dsh-pet] startup failed:', error);
  throw error;
}
