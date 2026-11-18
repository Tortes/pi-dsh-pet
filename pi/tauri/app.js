import { invoke } from '@tauri-apps/api/core';

const runtime = await invoke('runtime_config');
const port = Number(runtime.port);
const requestedSize = Number(runtime.size);

const root = document.querySelector('#pet-root');
const pet = document.createElement('div');
pet.className = 'pet';
pet.style.width = requestedSize + 'px';
pet.style.right = '24px';
pet.style.top = '100px';
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
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1');
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

async function loadConfig() {
  const response = await fetch('http://127.0.0.1:' + port + '/config.jsonc');
  config = JSON.parse(stripJsonc(await response.text()));
  play(pick(config.animations.idle));
}

function animationUrl(name) {
  return 'http://127.0.0.1:' + port + '/webm/' + encodeURIComponent(name) + '.webm';
}

function play(name, loop = false) {
  if (!name || name === current) return;
  current = name;
  video.loop = loop;
  video.src = animationUrl(name);
  video.play().catch(() => {});
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
      if (event.type === 'tool_call') {
        animation = /bash|shell|exec|python|terminal/i.test(event.tool || '')
          ? '写代码'
          : '轻快记录';
      }
    } catch {}
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

pet.addEventListener('pointerdown', () => {
  invoke('set_ignore_cursor_events', { ignore: false }).catch(() => {});
});
pet.addEventListener('pointerup', () => {
  invoke('set_ignore_cursor_events', { ignore: true }).catch(() => {});
});
pet.addEventListener('click', () => {
  if (config?.animations?.clicks?.length) play(pick(config.animations.clicks));
});

async function connect() {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  ws.onmessage = event => handleMessage(String(event.data));
  ws.onclose = () => setTimeout(connect, 1000);
}

await loadConfig();
await invoke('set_ignore_cursor_events', { ignore: true });
await connect();
