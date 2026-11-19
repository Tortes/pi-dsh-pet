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

const statusBubble = document.createElement('div');
statusBubble.className = 'pet-status-bubble';
statusBubble.hidden = true;
const statusTitle = document.createElement('div');
statusTitle.className = 'pet-status-title';
const statusDetail = document.createElement('div');
statusDetail.className = 'pet-status-detail';
statusBubble.append(statusTitle, statusDetail);
pet.appendChild(statusBubble);

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
  // The categories themselves are the root menu. A single "动作" wrapper only adds
  // an unnecessary hover level and makes the menu look like it has one item.
  return groups;
}

let activeMenuClose = null;
function closeContextMenu() {
  if (!activeMenuClose) return;
  const close = activeMenuClose;
  activeMenuClose = null;
  close();
}

function openContextMenu(event) {
  if (activeMenuClose || !config) return;
  event.preventDefault();
  event.stopPropagation();
  const tree = animationMenuTree();
  if (!tree.length) return;

  // Use a viewport-origin root, like the upstream menu: each cascading panel is
  // positioned in viewport coordinates, so left/right flipping is unambiguous.
  const rootMenu = document.createElement('div');
  rootMenu.className = 'pet-context-menu';
  rootMenu.style.left = '0px';
  rootMenu.style.top = '0px';
  rootMenu.addEventListener('contextmenu', e => e.preventDefault());

  const openChild = new Map();
  let closed = false;
  let leaveTimer = null;

  const cancelLeave = () => {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
  };
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer = window.setTimeout(closeContextMenu, 200);
  };

  const hideChain = panel => {
    panel.hidden = true;
    const child = openChild.get(panel);
    if (child) {
      openChild.delete(panel);
      hideChain(child);
    }
  };

  const placeChild = (child, item) => {
    child.hidden = false;
    const itemRect = item.getBoundingClientRect();
    const parentRect = item.parentElement.getBoundingClientRect();
    const width = child.offsetWidth;
    const height = child.offsetHeight;
    const gap = 4;
    const minLeft = 4;
    const minTop = 4;
    const maxLeft = Math.max(minLeft, window.innerWidth - width - 4);
    const maxTop = Math.max(minTop, window.innerHeight - height - 4);
    const clampLeft = value => Math.max(minLeft, Math.min(value, maxLeft));
    const clampTop = value => Math.max(minTop, Math.min(value, maxTop));

    const others = Array.from(rootMenu.querySelectorAll('.pet-context-menu-panel'))
      .filter(panel => panel !== child && !panel.hidden)
      .map(panel => panel.getBoundingClientRect());
    const overlaps = (left, top) => others.some(rect =>
      left < rect.right && left + width > rect.left &&
      top < rect.bottom && top + height > rect.top
    );
    const candidates = [
      { left: parentRect.right + gap, top: itemRect.top },
      { left: parentRect.left - width - gap, top: itemRect.top },
      { left: parentRect.right + gap, top: parentRect.top },
      { left: parentRect.left - width - gap, top: parentRect.top },
    ];

    let position = candidates.find(candidate =>
      candidate.left >= minLeft && candidate.left <= maxLeft &&
      candidate.top >= minTop && candidate.top <= maxTop &&
      !overlaps(candidate.left, candidate.top)
    );
    if (!position) {
      position = candidates
        .map(candidate => ({ left: clampLeft(candidate.left), top: clampTop(candidate.top) }))
        .find(candidate => !overlaps(candidate.left, candidate.top));
    }
    if (!position) {
      position = {
        left: clampLeft(parentRect.right + gap),
        top: clampTop(itemRect.top),
      };
    }

    child.style.left = position.left + 'px';
    child.style.top = position.top + 'px';
  };

  const buildPanel = nodes => {
    const panel = document.createElement('div');
    panel.className = 'pet-context-menu-panel';
    panel.hidden = true;
    rootMenu.appendChild(panel);

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
          const previous = openChild.get(panel);
          if (previous && previous !== child) hideChain(previous);
          openChild.set(panel, child);
          placeChild(child, item);
        });
      } else {
        item.addEventListener('mouseenter', () => {
          const previous = openChild.get(panel);
          if (previous) hideChain(previous);
        });
        item.addEventListener('click', () => {
          closeContextMenu();
          if (node.anim) play(node.anim, false);
        });
      }
      panel.appendChild(item);
    }
    return panel;
  };

  const rootPanel = buildPanel(tree);
  rootPanel.hidden = false;
  rootPanel.style.left = '';
  rootPanel.style.top = '';
  document.body.appendChild(rootMenu);

  const maxX = Math.max(4, window.innerWidth - rootPanel.offsetWidth - 4);
  const maxY = Math.max(4, window.innerHeight - rootPanel.offsetHeight - 4);
  rootPanel.style.left = Math.max(4, Math.min(event.clientX, maxX)) + 'px';
  rootPanel.style.top = Math.max(4, Math.min(event.clientY, maxY)) + 'px';

  const onOutside = e => {
    if (!rootMenu.contains(e.target)) closeContextMenu();
  };
  const onKey = e => {
    if (e.key === 'Escape') closeContextMenu();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cancelLeave();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    rootMenu.removeEventListener('mouseleave', scheduleLeave);
    rootMenu.removeEventListener('mouseover', cancelLeave);
    rootMenu.remove();
    invoke('set_menu_open', { open: false }).catch(() => {});
  };

  rootMenu.addEventListener('mouseleave', scheduleLeave);
  rootMenu.addEventListener('mouseover', cancelLeave);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  activeMenuClose = close;
  void invoke('set_menu_open', { open: true });
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


const STATUS_LABELS = {
  thinking: '思考中',
  working: '执行中',
  result: '整理结果',
  waiting: '等待确认',
  success: '已完成',
  error: '发生错误',
};
let lastAggregateState = null;

function renderAgentSnapshot(data) {
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const aggregate = data.aggregate ?? null;
  const selected = aggregate?.agent ?? null;

  if (agents.length === 0) {
    statusBubble.hidden = true;
  } else {
    statusBubble.hidden = false;
    if (selected) {
      statusTitle.textContent = agents.length + ' 个 Pi 进程 · ' +
        (selected.project || ('PID ' + selected.pid));
      const stateLabel = STATUS_LABELS[aggregate.state] ?? '运行中';
      statusDetail.textContent = stateLabel + (selected.task ? ' · ' + selected.task : '');
    } else {
      statusTitle.textContent = agents.length + ' 个 Pi 进程在线';
      statusDetail.textContent = '当前空闲，等待新的任务';
    }
  }

  const nextState = aggregate?.state ?? null;
  if (nextState !== lastAggregateState) {
    if (nextState) playWorkStatus(nextState);
    else {
      const idle = config?.animations?.idle;
      if (Array.isArray(idle) && idle.length) play(pick(idle), true);
    }
    lastAggregateState = nextState;
  }
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
      else if (event.type === 'agents_snapshot') renderAgentSnapshot(event);
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
