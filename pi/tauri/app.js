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
      dragSpring: physics.dragSpring !== false,
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


const MENU_EVENT_LABELS = { balance: '余额档位', whisper: '碎碎念', workStatus: '工作状态' };

function animationMenuTree() {
  const animations = config?.animations ?? {};
  const groups = [];
  const add = (label, names) => {
    const valid = (names ?? []).filter(name => typeof name === 'string' && name);
    if (valid.length) groups.push({ label, children: valid.map(name => ({ label: name, anim: name })) });
  };
  add('待机', animations.idle);
  add('转向', animations.turn);
  add('拖拽', animations.drag);
  add('点击回应', animations.clicks);
  add('移动', (animations.moves?.actions ?? []).map(item => item.name));
  for (const category of animations.categories ?? []) add(category.id, category.actions);
  for (const [key, slots] of Object.entries(animations.events ?? {})) {
    const names = [];
    for (const slot of slots ?? []) {
      if (typeof slot === 'string') names.push(slot);
      else if (Array.isArray(slot)) names.push(...slot.filter(name => typeof name === 'string'));
    }
    add(MENU_EVENT_LABELS[key] ?? key, names);
  }
  return groups.length ? [{ label: '动作', children: groups }] : [];
}

let activeMenu = null;
function closeContextMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  invoke('set_menu_open', { open: false }).catch(() => {});
}

function openContextMenu(event) {
  if (activeMenu || !config) return;
  event.preventDefault();
  event.stopPropagation();
  const tree = animationMenuTree();
  if (!tree.length) return;

  const rootMenu = document.createElement('div');
  rootMenu.className = 'pet-context-menu';
  rootMenu.addEventListener('contextmenu', e => e.preventDefault());
  const columns = [];
  const opened = new Map();
  let leaveTimer = null;
  const cancelLeave = () => {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
  };
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer = window.setTimeout(closeContextMenu, 180);
  };

  const hideChildren = panel => {
    const child = opened.get(panel);
    if (!child) return;
    opened.delete(panel);
    child.hidden = true;
    hideChildren(child);
  };

  const placeChild = (child, item) => {
    child.hidden = false;
    const itemRect = item.getBoundingClientRect();
    const menuRect = rootMenu.getBoundingClientRect();
    const width = child.offsetWidth;
    const height = child.offsetHeight;
    const gap = 4;
    let left = itemRect.right - menuRect.left + gap;
    if (menuRect.left + left + width > window.innerWidth - 6) {
      left = itemRect.left - menuRect.left - width - gap;
    }
    left = Math.max(4, Math.min(left, window.innerWidth - menuRect.left - width - 4));
    let top = itemRect.top - menuRect.top;
    top = Math.max(4, Math.min(top, window.innerHeight - menuRect.top - height - 4));
    child.style.left = left + 'px';
    child.style.top = top + 'px';
  };

  const buildPanel = nodes => {
    const panel = document.createElement('div');
    panel.className = 'pet-context-menu-panel';
    panel.hidden = true;
    panel.addEventListener('mouseenter', cancelLeave);
    panel.addEventListener('mouseleave', scheduleLeave);
    columns.push(panel);
    for (const node of nodes) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pet-context-menu-item';
      const label = document.createElement('span');
      label.textContent = node.label;
      item.appendChild(label);
      if (Array.isArray(node.children)) {
        item.classList.add('has-children');
        const arrow = document.createElement('span');
        arrow.className = 'pet-context-menu-arrow';
        arrow.textContent = '›';
        item.appendChild(arrow);
        const child = buildPanel(node.children);
        item.addEventListener('mouseenter', () => {
          const previous = opened.get(panel);
          if (previous && previous !== child) hideChildren(previous);
          opened.set(panel, child);
          placeChild(child, item);
        });
      } else {
        item.addEventListener('mouseenter', () => hideChildren(panel));
        item.addEventListener('click', () => {
          closeContextMenu();
          if (node.anim) play(node.anim, false);
        });
      }
      panel.appendChild(item);
    }
    rootMenu.appendChild(panel);
    return panel;
  };

  const rootPanel = buildPanel(tree);
  rootPanel.hidden = false;
  rootPanel.style.left = '0px';
  rootPanel.style.top = '0px';
  document.body.appendChild(rootMenu);
  const x = event.clientX;
  const y = event.clientY;
  const maxX = Math.max(4, window.innerWidth - rootPanel.offsetWidth - 4);
  const maxY = Math.max(4, window.innerHeight - rootPanel.offsetHeight - 4);
  rootMenu.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
  rootMenu.style.top = Math.max(4, Math.min(y, maxY)) + 'px';
  activeMenu = rootMenu;
  void invoke('set_menu_open', { open: true });

  rootMenu.addEventListener('mouseover', cancelLeave);
  const onOutside = e => {
    if (!rootMenu.contains(e.target)) closeContextMenu();
  };
  const onKey = e => {
    if (e.key === 'Escape') closeContextMenu();
  };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  const cleanup = rootMenu.remove.bind(rootMenu);
  rootMenu.remove = () => {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    cleanup();
  };
}

pet.addEventListener('contextmenu', openContextMenu);

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
