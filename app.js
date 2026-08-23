// ── состояние ────────────────────────────────────────────────────────────────
const S = {
  owner: localStorage.getItem('gh-owner') || 'nemalex357',
  token: localStorage.getItem('gh-token') || '',
  repo: 'dashboard-data',
  snap: JSON.parse(localStorage.getItem('mob-snap') || 'null'),
  reports: JSON.parse(localStorage.getItem('mob-reports') || 'null'),
  pending: JSON.parse(localStorage.getItem('mob-pending') || '[]'),
  view: location.hash.slice(1) || 'today',
};

const API = 'https://api.github.com';
const hdrs = () => ({ Authorization: `Bearer ${S.token}`, 'X-GitHub-Api-Version': '2022-11-28' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

// ── GitHub API ───────────────────────────────────────────────────────────────
async function ghGetJson(path) {
  const r = await fetch(`${API}/repos/${S.owner}/${S.repo}/contents/${path}?t=${Date.now()}`, {
    headers: { ...hdrs(), Accept: 'application/vnd.github.raw+json' },
  });
  if (r.status === 401 || r.status === 403) throw { auth: true };
  if (!r.ok) return null;
  return r.json();
}
async function ghGetMeta(path) {
  const r = await fetch(`${API}/repos/${S.owner}/${S.repo}/contents/${path}?t=${Date.now()}`, { headers: hdrs() });
  if (!r.ok) return null;
  return r.json(); // { sha, content(base64) }
}
function b64encode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function b64decode(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
}
async function ghPut(path, contentStr, sha, message) {
  const body = { message, content: b64encode(contentStr) };
  if (sha) body.sha = sha;
  const r = await fetch(`${API}/repos/${S.owner}/${S.repo}/contents/${path}`, {
    method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.ok ? r.json() : Promise.reject({ status: r.status });
}

// ── журнал действий ──────────────────────────────────────────────────────────
function enqueue(action) {
  S.pending.push({ id: uid(), ts: new Date().toISOString(), ...action });
  save('mob-pending', S.pending);
  render();
  flush();
}
let flushing = false;
async function flush() {
  if (flushing || !S.pending.length || !navigator.onLine) return;
  flushing = true;
  try {
    for (let attempt = 0; attempt < 5 && S.pending.length; attempt++) {
      const meta = await ghGetMeta('inbox.json');
      const list = meta ? JSON.parse(b64decode(meta.content)) : [];
      const known = new Set(list.map((x) => x.id));
      const add = S.pending.filter((x) => !known.has(x.id));
      try {
        await ghPut('inbox.json', JSON.stringify([...list, ...add], null, 1) + '\n', meta?.sha, 'телефон: ' + add.map((a) => a.op).join(', '));
        S.pending = [];
        save('mob-pending', S.pending);
      } catch (e) {
        if (e.status === 409 || e.status === 422) continue; // sha устарел — перечитать и повторить
        break;
      }
    }
  } catch { /* останется в pending */ }
  flushing = false;
  render();
}

// ── наложение pending на сводку (оптимистичный экран) ────────────────────────
function openTasks(card) {
  let tasks = card.tasks.slice();
  for (const a of S.pending) {
    if (a.op === 'toggle-task' && a.card === card.slug) {
      tasks = a.done ? tasks.filter((t) => t.id !== a.task) : tasks;
    }
    if (a.op === 'add-task' && a.card === card.slug) {
      tasks.push({ id: a.id, title: a.text, important: false, pinned: false, local: true });
    }
  }
  return tasks;
}
function cardList() {
  const cards = (S.snap?.cards ?? []).slice();
  for (const a of S.pending) {
    if (a.op === 'create-card') {
      cards.unshift({ slug: 'local-' + a.id, name: a.name, sphere: a.sphere, kind: a.kind, status: 'active', tasks: [], local: true });
    }
  }
  return cards;
}

// ── загрузка данных ──────────────────────────────────────────────────────────
async function refresh() {
  try {
    const snap = await ghGetJson('mobile.json');
    if (snap) { S.snap = snap; save('mob-snap', snap); }
    document.getElementById('offline').hidden = true;
  } catch (e) {
    if (e.auth) return showLogin('токен не подошёл или истёк');
    document.getElementById('offline').hidden = false;
  }
  render();
  flush();
}

// ── экраны ───────────────────────────────────────────────────────────────────
const SPHERES = { personal: ['🏠', 'Личное', 'p'], garant: ['💼', 'Garant IN', 'g'], ai: ['✦', 'AI', 'ai'] };

function taskRow(card, t) {
  return `<div class="tk">
    <span class="box" data-toggle="${esc(card.slug)}|${esc(t.id)}"></span>
    <p>${esc(t.title)}<a class="src" href="#card/${esc(card.slug)}">${esc(card.name)}</a></p>
    ${t.important ? '<span class="imp"></span>' : ''}
  </div>`;
}

function viewToday() {
  const s = S.snap;
  if (!s) return '<p class="lab">загружаю…</p>';
  const byCard = Object.fromEntries(cardList().map((c) => [c.slug, c]));
  const focus = s.focus.filter((f) => byCard[f.card] && openTasks(byCard[f.card]).some((t) => t.id === f.task));
  const imp = s.important
    .map((g) => ({ ...g, items: g.items.filter((i) => byCard[i.card] && openTasks(byCard[i.card]).some((t) => t.id === i.task)) }))
    .filter((g) => g.items.length);
  const rec = s.recurring.filter((r) => r.status === 'due' || r.status === 'soon');
  return `
    <div class="hd"><h2>Сегодня</h2><span class="day">${new Date().toLocaleDateString('ru', { weekday: 'short', day: 'numeric', month: 'short' })}</span></div>
    ${focus.length ? `<div class="fb"><div class="k">📌 фокус</div>${focus.map((f) => `<div class="it" data-goto="#card/${esc(f.card)}"><p>${esc(f.title)}</p><small>${esc(f.cardName)}</small></div>`).join('')}</div>` : ''}
    ${imp.map((g) => `<div class="sec"><div class="st"><span class="lab">🔴 важные · ${SPHERES[g.sphere]?.[1] ?? g.sphere}</span><span class="cnt">${g.items.length}</span></div>${g.items.map((i) => taskRow({ slug: i.card, name: i.cardName }, { id: i.task, title: i.title, important: true })).join('')}</div>`).join('')}
    ${rec.length ? `<div class="sec"><div class="st"><span class="lab">🔁 повторяющиеся</span><span class="cnt">${rec.length}</span></div>${rec.map((r) => `<div class="tk"><p>${esc(r.title)}<span class="src">${esc(r.statusLabel)}</span></p></div>`).join('')}</div>` : ''}`;
}

const VIEWS = { today: viewToday };

function render() {
  const el = document.getElementById('screen');
  const name = S.view.split('/')[0];
  el.innerHTML = (VIEWS[name] ?? viewToday)();
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.hash === '#' + name));
}

// ── события ──────────────────────────────────────────────────────────────────
document.getElementById('screen').addEventListener('click', (e) => {
  const box = e.target.closest('[data-toggle]');
  if (box) {
    const [card, task] = box.dataset.toggle.split('|');
    enqueue({ op: 'toggle-task', card, task, done: true });
    return;
  }
  const go = e.target.closest('[data-goto]');
  if (go) location.hash = go.dataset.goto;
});
window.addEventListener('hashchange', () => { S.view = location.hash.slice(1) || 'today'; render(); });
window.addEventListener('online', flush);

// ── вход ─────────────────────────────────────────────────────────────────────
function showLogin(err) {
  document.getElementById('login').hidden = false;
  document.getElementById('app').hidden = true;
  document.getElementById('login-err').textContent = err || '';
}
document.getElementById('btn-login').addEventListener('click', async () => {
  S.owner = document.getElementById('in-owner').value.trim();
  S.token = document.getElementById('in-token').value.trim();
  localStorage.setItem('gh-owner', S.owner);
  localStorage.setItem('gh-token', S.token);
  boot();
});
function boot() {
  if (!S.token) return showLogin();
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  render();
  refresh();
}
boot();
