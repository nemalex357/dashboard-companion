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
async function ghPutBinary(path, blob, message) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const r = await fetch(`${API}/repos/${S.owner}/${S.repo}/contents/${path}`, {
    method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: btoa(bin) }),
  });
  if (!r.ok) throw { status: r.status };
}

// ── голосовая запись ─────────────────────────────────────────────────────────
let rec = null, chunks = [];
async function toggleMic() {
  const hint = document.getElementById('mic-hint');
  if (rec) {
    rec.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const ext = (rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
      rec = null;
      const blob = new Blob(chunks);
      const name = `voice/${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      hint.textContent = 'отправляю запись…';
      try {
        await ghPutBinary(name, blob, 'телефон: голосовая запись');
        enqueue({ op: 'voice', file: name });
        hint.textContent = 'ушло — расшифруется дома, появится в «Мыслях»';
      } catch {
        hint.textContent = 'не удалось отправить — попробуй ещё раз при сети';
      }
    };
    rec.start();
    hint.textContent = '● запись… нажми ещё раз, чтобы остановить';
  } catch {
    hint.textContent = 'нет доступа к микрофону';
  }
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
      if (add.length < S.pending.length) {
        S.pending = S.pending.filter((x) => !known.has(x.id));
        save('mob-pending', S.pending);
      }
      if (!add.length) break;
      try {
        await ghPut('inbox.json', JSON.stringify([...list, ...add], null, 1) + '\n', meta?.sha, 'телефон: ' + add.map((a) => a.op).join(', '));
        S.pending = S.pending.filter((x) => !add.some((a) => a.id === x.id));
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

let sphereFilter = localStorage.getItem('mob-sphere') || 'all';

function viewCards() {
  if (!S.snap) return '<p class="lab">загружаю…</p>';
  const cards = cardList().filter((c) => sphereFilter === 'all' || c.sphere === sphereFilter);
  const tabs = [['all', 'Все'], ['personal', 'Личное'], ['garant', 'Garant'], ['ai', 'AI']];
  return `
    <div class="hd"><h2>Карточки</h2><span class="plus" data-goto="#new">+</span></div>
    <div class="tabs">${tabs.map(([k, l]) => `<span class="tab ${sphereFilter === k ? 'on' : ''}" data-sphere="${k}">${l}</span>`).join('')}</div>
    ${cards.map((c) => {
      const [icon, , cls] = SPHERES[c.sphere] ?? ['·', '', 'ai'];
      const n = openTasks(c).length;
      return `<div class="pc" data-goto="#card/${esc(c.slug)}"><span class="sph ${cls}">${icon}</span><span class="nm"><b>${esc(c.name)}</b><span>${SPHERES[c.sphere]?.[1] ?? ''} · ${c.kind === 'task' ? 'задача' : 'проект'}${c.status !== 'active' ? ' · ' + esc(c.status) : ''}</span></span><span class="n">${n || ''}</span></div>`;
    }).join('')}`;
}

function viewCard() {
  const slug = S.view.split('/')[1];
  const card = cardList().find((c) => c.slug === slug);
  if (!card) return '<p class="lab">карточка не найдена</p>';
  const tasks = openTasks(card);
  const hasReq = S.pending.some((a) => a.op === 'ask-agent' && a.target === slug);
  return `
    <div class="hd"><h2>${esc(card.name)}</h2><span class="day">${SPHERES[card.sphere]?.[0] ?? ''} ${SPHERES[card.sphere]?.[1] ?? ''}</span></div>
    <div class="sec">
      <div class="st"><span class="lab">задачи</span><span class="cnt">${tasks.length} откр.</span></div>
      ${tasks.map((t) => `<div class="tk"><span class="box" data-toggle="${esc(card.slug)}|${esc(t.id)}"></span><p>${esc(t.title)}${t.local ? '<span class="src">ещё не синхронизировано</span>' : ''}</p>${t.important ? '<span class="imp"></span>' : ''}</div>`).join('') || '<p class="lab" style="padding:8px 0">открытых нет</p>'}
    </div>
    ${card.local ? '' : `
      <div class="tk" style="border:none;padding:0 0 12px"><textarea id="new-task" class="inp" rows="1" placeholder="+ добавить задачу…"></textarea><button class="pi-run" id="btn-add-task" style="margin-left:8px">ОК</button></div>
      ${hasReq ? '<div class="q"><b>⏳ Агент в очереди</b>выполнится, когда откроешь систему на компьютере</div>' : `<div class="chips">${[['marketolog', '📣 Маркетолог'], ['strateg', '♟ Стратег']].map(([slug, l]) => `<span class="chip" data-ask="${slug}">${l}</span>`).join('')}</div>
       <p class="lab" style="text-transform:none;letter-spacing:0">спросить агента — выполнится дома</p>`}`}`;
}

function viewNew() {
  return `
    <div class="hd"><h2>Новая карточка</h2><span class="day" data-goto="#cards">✕</span></div>
    <p class="step">1 · сфера</p>
    <div class="pick">
      <div class="pk" data-pick-sphere="personal"><i>🏠</i><b>Личное</b><small>задача</small></div>
      <div class="pk" data-pick-sphere="garant"><i>💼</i><b>Garant IN</b><small>задача</small></div>
      <div class="pk" data-pick-sphere="ai"><i>✦</i><b>AI</b><small>проект или задача</small></div>
    </div>
    <p class="step" id="kind-step" hidden>2 · тип</p>
    <div class="chips" id="kind-pick" hidden>
      <span class="chip on" data-pick-kind="project">Проект</span>
      <span class="chip" data-pick-kind="task">Задача</span>
    </div>
    <p class="step">название</p>
    <textarea id="new-name" class="ta" rows="2" placeholder="Что за дело?"></textarea>
    <button class="btn" id="btn-create" style="margin-top:14px">Создать карточку</button>
    <p class="lab" style="text-align:center;margin-top:12px;text-transform:none;letter-spacing:0">появится дома сразу; цель и анализ Claude подтянет на компьютере</p>`;
}

let writeKind = 'thought'; // thought | task | decision
let writeDraft = '';

function viewWrite() {
  const kinds = [['thought', 'Мысль'], ['task', 'Задача'], ['decision', 'Решение']];
  const needCard = writeKind === 'task';
  return `
    <div class="hd"><h2>Записать</h2><span class="day">быстрый захват</span></div>
    <div class="chips">${kinds.map(([k, l]) => `<span class="chip ${writeKind === k ? 'on' : ''}" data-write-kind="${k}">${l}</span>`).join('')}</div>
    ${needCard ? `<select id="write-card" class="inp" style="margin-bottom:10px">${cardList().filter((c) => !c.local).map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select>` : ''}
    <textarea id="write-text" class="ta" placeholder="${writeKind === 'thought' ? 'Что пришло в голову…' : writeKind === 'task' ? 'Что нужно сделать…' : 'Что решил…'}">${esc(writeDraft)}</textarea>
    <div class="mic" id="btn-mic">🎤</div>
    <p class="lab" style="text-align:center;margin:8px 0 14px;text-transform:none;letter-spacing:0" id="mic-hint">или продиктовать — расшифруется дома</p>
    <button class="btn" id="btn-save-write">Сохранить</button>`;
}

function viewReports() {
  const r = S.reports;
  if (!r) { loadReports(); return '<div class="hd"><h2>Разборы</h2></div><p class="lab">загружаю…</p>'; }
  const md = (s) => esc(s).replace(/\n/g, '<br>');
  return `
    <div class="hd"><h2>Разборы</h2><span class="day">читалка</span></div>
    ${r.day ? `<div class="art"><h3>✦ Обзор дня</h3><div class="meta">${esc(r.day.dayKey)}</div><p>${md(r.day.synthesis)}</p>${r.day.focus ? `<div class="fc"><span class="lab">на что обратить внимание</span><p style="margin:0">${md(r.day.focus)}</p></div>` : ''}</div><div style="height:12px"></div>` : ''}
    ${r.week ? `<div class="art"><h3>📅 Обзор недели</h3><div class="meta">неделя с ${esc(r.week.weekKey)}</div><p>${md(r.week.synthesis)}</p>${r.week.focus ? `<div class="fc"><span class="lab">фокус недели</span><p style="margin:0">${md(r.week.focus)}</p></div>` : ''}</div><div style="height:12px"></div>` : ''}
    ${r.board ? `<div class="art"><h3>🎯 Совет директоров</h3><div class="meta">${esc(r.board.convenedAt ?? '')}</div><p><b>Вердикт:</b> ${md(r.board.verdict)}</p><p><b>Главный шаг:</b> ${md(r.board.nextStep)}</p>${r.board.members.map((m) => `<p>${esc(m.icon)} <b>${esc(m.role)}:</b> ${md(m.advice)}</p>`).join('')}</div><div style="height:12px"></div>` : ''}
    ${r.agents.map((a) => `<div class="rd" data-full="${esc(a.agent)}"><div class="t"><span>🤖 ${esc(a.agent)}${a.scope !== 'all' ? ' · ' + esc(a.scope) : ''}</span><em>${esc(a.ranAt)}</em></div><p>${md(a.summary)}</p><div class="art" hidden><p>${md(a.full)}</p></div></div>`).join('')}`;
}

async function loadReports() {
  try {
    const r = await ghGetJson('mobile-reports.json');
    if (r) { S.reports = r; save('mob-reports', r); render(); }
  } catch { /* оффлайн — показываем кэш */ }
}

const VIEWS = { today: viewToday };
Object.assign(VIEWS, { cards: viewCards, card: viewCard, new: viewNew });
Object.assign(VIEWS, { write: viewWrite, reports: viewReports });

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
  if (go) { location.hash = go.dataset.goto; return; }

  const tab = e.target.closest('[data-sphere]');
  if (tab) { sphereFilter = tab.dataset.sphere; localStorage.setItem('mob-sphere', sphereFilter); render(); return; }

  if (e.target.id === 'btn-add-task') {
    const ta = document.getElementById('new-task');
    const text = ta.value.trim();
    if (text) enqueue({ op: 'add-task', card: S.view.split('/')[1], text });
    return;
  }
  const ask = e.target.closest('[data-ask]');
  if (ask) { enqueue({ op: 'ask-agent', agent: ask.dataset.ask, target: S.view.split('/')[1] }); return; }
  const ps = e.target.closest('[data-pick-sphere]');
  if (ps) {
    document.querySelectorAll('[data-pick-sphere]').forEach((x) => x.classList.toggle('on', x === ps));
    const isAi = ps.dataset.pickSphere === 'ai';
    document.getElementById('kind-step').hidden = !isAi;
    document.getElementById('kind-pick').hidden = !isAi;
    return;
  }
  const pk = e.target.closest('[data-pick-kind]');
  if (pk) { document.querySelectorAll('[data-pick-kind]').forEach((x) => x.classList.toggle('on', x === pk)); return; }
  if (e.target.id === 'btn-create') {
    const sphere = document.querySelector('[data-pick-sphere].on')?.dataset.pickSphere;
    const name = document.getElementById('new-name').value.trim();
    if (!sphere || !name) return;
    const kind = sphere === 'ai' ? (document.querySelector('[data-pick-kind].on')?.dataset.pickKind ?? 'project') : 'task';
    enqueue({ op: 'create-card', name, sphere, kind });
    location.hash = '#cards';
    return;
  }
  const wk = e.target.closest('[data-write-kind]');
  if (wk) { writeDraft = document.getElementById('write-text')?.value ?? writeDraft; writeKind = wk.dataset.writeKind; render(); return; }
  if (e.target.id === 'btn-save-write') {
    const text = document.getElementById('write-text').value.trim();
    if (!text) return;
    if (writeKind === 'task') {
      const card = document.getElementById('write-card')?.value;
      if (!card) return;
    }
    if (writeKind === 'thought') enqueue({ op: 'add-thought', text });
    if (writeKind === 'decision') enqueue({ op: 'add-decision', text });
    if (writeKind === 'task') enqueue({ op: 'add-task', card: document.getElementById('write-card').value, text });
    document.getElementById('write-text').value = '';
    writeDraft = '';
    return;
  }
  const rd = e.target.closest('[data-full]');
  if (rd) { const f = rd.querySelector('.art'); if (f) f.hidden = !f.hidden; return; }
  if (e.target.id === 'btn-mic') { toggleMic(); return; }
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
