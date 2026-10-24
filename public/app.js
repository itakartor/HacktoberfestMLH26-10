const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_LABEL = {
  non_specificato: 'non specificato', ambiguo: 'ambiguo', da_verificare: 'da verificare',
  confermato: 'confermato', contestato: 'contestato', superato: 'superato',
};
const KIND_LABEL = {
  commitment: 'Impegni', decision: 'Decisioni', open_question: 'Domande aperte',
  risk: 'Rischi e vincoli', need: 'Esigenze', fact: 'Dichiarazioni',
};
const CERTAINTY_LABEL = { certo: 'esplicito', condizionato: 'condizionato', ipotetico: 'ipotetico', ambiguo: 'incerto', negato: 'negazione' };

const state = {
  user: localStorageGet('user') || 'luca',
  sessionId: null,
  data: null,           // last /api/sessions/:id payload
  partials: new Map(),  // channel -> { id, speaker, text }
  ws: null,
  wsWanted: false,
  audio: null,          // { ctx, streams, nodes }
  templates: [],
  editing: null,
};

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-user-id': state.user, ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

function toast(text, level = '') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

// ------------------------------------------------------------------ boot

async function boot() {
  const users = await api('/api/users');
  $('#user').innerHTML = users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  $('#user').value = state.user;
  $('#user').onchange = () => { state.user = $('#user').value; localStorageSet('user', state.user); closeSession(); loadSessions(); };

  state.templates = await api('/api/templates');
  const opts = state.templates.map((t) => `<option value="${t.id}">${esc(t.name)} (v${t.version})</option>`).join('');
  $('#template-select').innerHTML = opts;
  $('#live-template').innerHTML = opts;
  document.querySelectorAll('.tpl-options').forEach((s) => { s.innerHTML = opts; });

  const scenarios = await api('/api/scenarios');
  state.scenarios = scenarios;
  $('#scenario').innerHTML = scenarios.map((s) => `<option value="${s.id}" title="${esc(s.description)}">${esc(s.title)}</option>`).join('');

  $('#new-session').onsubmit = createSession;
  $('#btn-audio').onclick = toggleAudio;
  $('#btn-demo').onclick = runDemo;
  $('#btn-complete').onclick = completeSession;
  $('#btn-delete').onclick = deleteSession;
  $('#live-template').onchange = changeTemplate;
  $('#ask-form').onsubmit = ask;
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  document.querySelectorAll('.tabs button[data-atab]').forEach((b) => { b.onclick = () => showArchiveTab(b.dataset.atab); });
  $('#btn-archive').onclick = openArchive;
  document.querySelectorAll('.seed-btn').forEach((b) => { b.onclick = seedDemo; });
  $('#gsearch-form').onsubmit = globalSearch;
  $('#doc-form').onsubmit = addDocument;
  $('#import-form').onsubmit = importConversation;

  renderHealth();
  setInterval(renderHealth, 15000);
  await loadSessions();
  const last = localStorageGet(`session:${state.user}`);
  if (last) openSession(last).catch(() => {});
}

async function renderHealth() {
  try {
    const h = await api('/api/health');
    const b = (ok, label, title = '') => `<span class="badge ${ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'bad'}" title="${esc(title)}">${esc(label)}</span>`;
    $('#health').innerHTML = [
      b(h.stt.configured, `STT ${h.stt.configured ? 'ElevenLabs' : 'non configurato'}`, h.stt.model),
      b(h.llm.reachable && h.llm.llm ? true : h.llm.reachable ? 'warn' : false, `Gemma ${h.llm.llm ? 'pronto' : h.llm.reachable ? 'modello mancante' : 'offline → regole'}`, h.llm.model),
      b(h.llm.embed ? true : 'warn', `Embedding ${h.llm.embed ? 'ok' : 'off → solo testo'}`, h.llm.embed_model),
      b(true, `DB ${h.db}`),
      ...h.external_data_flows.map((f) => b('warn', 'Dati esterni', f)),
    ].join('');
  } catch {
    $('#health').innerHTML = '<span class="badge bad">server non raggiungibile</span>';
  }
}

// -------------------------------------------------------------- sessions

async function loadSessions() {
  const list = await api('/api/sessions');
  $('#sessions').innerHTML = list.map((s) => `
    <li data-id="${s.id}" class="${s.id === state.sessionId ? 'active' : ''}">
      <div class="s-main">
        <div>${esc(s.title)}</div>
        <div class="s-sub">${esc(s.project)} · ${esc(s.template_id)} · ${statusLabel(s.status)} · ${s.segments} segm.</div>
      </div>
      <button class="trash" data-trash="${s.id}" title="Elimina conversazione" aria-label="Elimina «${esc(s.title)}»">🗑</button>
    </li>`).join('') || '<li class="muted">Nessuna conversazione</li>';
  document.querySelectorAll('#sessions li[data-id]').forEach((li) => { li.onclick = () => openSession(li.dataset.id); });
  document.querySelectorAll('#sessions [data-trash]').forEach((b) => { b.onclick = (e) => trashSession(e, b); });
}

// Two-step delete without browser dialogs: first click arms, second confirms.
async function trashSession(e, btn) {
  e.stopPropagation();
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Elimina?';
    btn.classList.add('armed');
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = '🗑'; btn.classList.remove('armed'); } }, 3500);
    return;
  }
  const id = btn.dataset.trash;
  try {
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
    if (state.sessionId === id) {
      localStorageSet(`session:${state.user}`, '');
      closeSession();
    }
    toast('Conversazione eliminata con trascrizione, estrazioni e report', 'ok');
    loadSessions();
  } catch (err) { toast(err.message, 'high'); }
}

const statusLabel = (s) => ({ created: 'creata', live: 'live', processing: 'in elaborazione', completed: 'completata' }[s] || s);

async function createSession(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const s = await api('/api/sessions', {
      method: 'POST',
      body: {
        title: f.get('title'), project: f.get('project'), templateId: f.get('templateId'), context: f.get('context') || null,
        consent: f.get('consent') === 'on', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    e.target.reset();
    e.target.project.value = s.project;
    await loadSessions();
    await openSession(s.id);
  } catch (err) { toast(err.message, 'high'); }
}

async function openSession(id) {
  if (state.sessionId !== id) closeSession();
  state.sessionId = id;
  localStorageSet(`session:${state.user}`, id);
  await refresh();
  const match = state.scenarios?.find((s) => s.template === state.data.session.template_id);
  if (match) $('#scenario').value = match.id;
  $('#empty').hidden = true;
  $('#archive').hidden = true;
  $('#btn-archive').classList.remove('active');
  $('#session').hidden = false;
  connectWs();
  loadSessions();
}

function closeSession() {
  stopAudio(false);
  state.wsWanted = false;
  state.ws?.close(1000);
  state.ws = null;
  state.sessionId = null;
  state.data = null;
  state.partials.clear();
  $('#session').hidden = true;
  $('#archive').hidden = true;
  $('#btn-archive').classList.remove('active');
  $('#empty').hidden = false;
}

let refreshTimer = null;
function scheduleRefresh(ms = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), ms);
}

async function refresh() {
  if (!state.sessionId) return;
  const prevStatus = state.data?.session.status;
  state.data = await api(`/api/sessions/${state.sessionId}`);
  renderSession();
  if (prevStatus && prevStatus !== state.data.session.status) loadSessions();
}

async function completeSession() {
  if (!state.data) return;
  $('#btn-complete').disabled = true;
  $('#btn-complete').textContent = 'Elaborazione post-chiamata…';
  stopAudio(true);
  try {
    await api(`/api/sessions/${state.sessionId}/complete`, { method: 'POST' });
    await refresh();
    showTab('report');
    toast('Report post-chiamata pronto', 'ok');
  } catch (err) { toast(err.message, 'high'); } finally {
    $('#btn-complete').textContent = 'Termina chiamata';
    loadSessions();
  }
}

async function deleteSession() {
  const btn = $('#btn-delete');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Conferma eliminazione';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Elimina'; }, 4000);
    return;
  }
  btn.dataset.confirm = '';
  btn.textContent = 'Elimina';
  await api(`/api/sessions/${state.sessionId}`, { method: 'DELETE' });
  localStorageSet(`session:${state.user}`, '');
  closeSession();
  loadSessions();
  toast('Sessione e dati derivati eliminati', 'ok');
}

async function changeTemplate() {
  try {
    const r = await api(`/api/sessions/${state.sessionId}/template`, { method: 'POST', body: { template_id: $('#live-template').value } });
    toast(`Template cambiato: ${r.template_id} v${r.version}. Gli elementi già estratti conservano il template originale.`);
    refresh();
  } catch (err) { toast(err.message, 'high'); }
}

async function runDemo() {
  try {
    const sc = $('#scenario').value;
    await api(`/api/sessions/${state.sessionId}/simulate`, { method: 'POST', body: { scenario: sc } });
    toast('Scenario avviato: trascrizione simulata in streaming');
  } catch (err) { toast(err.message, 'high'); }
}

// -------------------------------------------------------------- websocket

function connectWs(attempt = 0) {
  if (!state.sessionId) return;
  state.wsWanted = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?session=${state.sessionId}&user=${state.user}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  ws.onopen = () => {
    hideBanner();
    if (state.audio) sendStartAudio(); // resume after a reconnect
  };
  ws.onmessage = (m) => onWsMessage(JSON.parse(m.data));
  ws.onclose = (ev) => {
    if (state.ws !== ws || !state.wsWanted || ev.code === 4404) return;
    showBanner('Connessione al server persa: riconnessione in corso… L\'audio di questo intervallo potrebbe non essere trascritto.');
    setTimeout(() => connectWs(attempt + 1), Math.min(8000, 500 * 2 ** attempt));
  };
}

function onWsMessage(msg) {
  if (msg.kind === 'stt') {
    const el = document.querySelector(`#ch-status [data-ch="${msg.channel}"]`);
    if (el) {
      el.className = `badge ${msg.state === 'ready' ? 'ok' : msg.state === 'warning' ? 'warn' : 'bad'}`;
      el.title = msg.message || '';
      el.textContent = `${msg.channel === 'mic' ? 'Microfono' : 'Scheda'}: ${msg.state === 'ready' ? 'in ascolto' : msg.state}`;
    }
    if (msg.state === 'error') toast(`STT ${msg.channel}: ${msg.message}`, 'high');
    return;
  }
  if (msg.kind === 'error') return toast(msg.message, 'high');
  const ev = msg.event;
  switch (ev.type) {
    case 'transcript_partial':
      state.partials.set(ev.payload.channel, { id: ev.segment_id, speaker: ev.speaker, text: ev.payload.text, channel: ev.payload.channel });
      renderTranscript();
      break;
    case 'transcript_final':
      state.partials.delete(ev.payload.channel);
      if (state.data && !state.data.segments.some((s) => s.id === ev.segment_id)) {
        state.data.segments.push({ id: ev.segment_id, seq: ev.payload.seq, speaker: ev.speaker, channel: ev.payload.channel, text: ev.payload.text, version: 1, status: 'final', extraction_state: 'pending' });
      }
      renderTranscript();
      scheduleRefresh(1500);
      break;
    case 'question_suggested':
    case 'verification_required':
      if (ev.payload.suggestion) toast(`${ev.payload.suggestion.kind === 'question' ? '❓' : '⚠'} ${ev.payload.suggestion.text}`, ev.payload.suggestion.priority === 'high' ? 'high' : '');
      scheduleRefresh();
      break;
    case 'connection_lost':
      showBanner(`Connessione persa (${ev.payload.channel}). Gli intervalli audio persi vengono tracciati.`);
      scheduleRefresh();
      break;
    case 'connection_restored':
      hideBanner();
      toast(`Connessione ripristinata (${ev.payload.channel}), interruzione di ${Math.round((ev.payload.gap_ms || 0) / 1000)} s`);
      scheduleRefresh();
      break;
    case 'extraction_failed':
      toast('Output di Gemma non valido: messo in quarantena, uso l\'estrazione di riserva a regole.', 'high');
      scheduleRefresh();
      break;
    case 'report_ready':
      scheduleRefresh();
      break;
    default:
      scheduleRefresh();
  }
}

function showBanner(text) { $('#banner').textContent = text; $('#banner').hidden = false; }
function hideBanner() { $('#banner').hidden = true; }

// ------------------------------------------------------------------ audio

async function toggleAudio() {
  if (state.audio) return stopAudio(true);
  const want = { mic: $('#ch-mic').checked, tab: $('#ch-tab').checked };
  if (!want.mic && !want.tab) return toast('Seleziona almeno una sorgente audio', 'high');
  try {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const streams = [];
    const nodes = [];
    const channels = [];
    const addSource = (stream, name, byte) => {
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (e) => {
        if (state.ws?.readyState !== WebSocket.OPEN) return;
        const pcm = new Uint8Array(e.data);
        const frame = new Uint8Array(pcm.length + 1);
        frame[0] = byte;
        frame.set(pcm, 1);
        state.ws.send(frame);
      };
      src.connect(node);
      nodes.push(src, node);
      channels.push(name);
    };
    if (want.mic) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      streams.push(mic);
      addSource(mic, 'mic', 0);
    }
    if (want.tab) {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      disp.getVideoTracks().forEach((t) => t.stop());
      if (!disp.getAudioTracks().length) {
        toast('Nessun audio dalla scheda: scegli una scheda e attiva "Condividi audio della scheda". L\'interlocutore NON verrà trascritto.', 'high');
      } else {
        const audioOnly = new MediaStream(disp.getAudioTracks());
        streams.push(disp);
        addSource(audioOnly, 'tab', 1);
      }
    }
    if (!channels.length) { ctx.close(); return; }
    state.audio = { ctx, streams, nodes, channels };
    sendStartAudio();
    $('#btn-audio').textContent = '■ Ferma audio';
    $('#btn-audio').classList.remove('primary');
    $('#btn-audio').classList.add('danger');
    $('#ch-status').innerHTML = channels.map((c) => `<span class="badge warn" data-ch="${c}">${c === 'mic' ? 'Microfono' : 'Scheda'}: connessione…</span>`).join('');
    if (!channels.includes('tab')) toast('Stai acquisendo solo il microfono: l\'audio remoto della chiamata non è incluso.', '');
  } catch (err) {
    toast(`Audio non disponibile: ${err.message}`, 'high');
  }
}

function sendStartAudio() {
  state.ws?.send(JSON.stringify({ type: 'start_audio', channels: state.audio.channels }));
}

function stopAudio(notify) {
  if (!state.audio) return;
  if (notify) state.ws?.send(JSON.stringify({ type: 'stop_audio' }));
  state.audio.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  state.audio.ctx.close();
  state.audio = null;
  $('#btn-audio').textContent = '● Avvia audio';
  $('#btn-audio').classList.add('primary');
  $('#btn-audio').classList.remove('danger');
  $('#ch-status').innerHTML = '';
}

// -------------------------------------------------------------- rendering

function renderSession() {
  const { session, template } = state.data;
  $('#s-title').textContent = session.title;
  $('#s-meta').innerHTML = [
    `<span>Progetto: <b>${esc(session.project)}</b></span>`,
    `<span>Template: <b>${esc(template.name)}</b> v${session.template_version}</span>`,
    `<span>Stato: <b>${statusLabel(session.status)}</b></span>`,
    session.timezone ? `<span>Fuso: ${esc(session.timezone)}</span>` : '',
    session.started_at ? `<span>Inizio: ${new Date(session.started_at).toLocaleString('it-IT')}</span>` : '',
  ].join('');
  $('#live-template').value = session.template_id;
  const done = session.status === 'completed' || session.status === 'processing';
  $('#btn-complete').disabled = done;
  $('#btn-audio').disabled = done;
  $('#btn-demo').disabled = done;
  $('#btn-md').href = '#';
  $('#btn-md').onclick = downloadMarkdown;
  renderTranscript();
  renderSuggestions();
  renderFields();
  renderItems();
  renderReport();
  $('#quarantine').textContent = state.data.quarantined ? `${state.data.quarantined} output scartati (quarantena)` : '';
}

function segLabel(id) {
  const s = state.data?.segments.find((x) => x.id === id);
  return s ? `S${s.seq}` : '?';
}

function renderTranscript() {
  if (!state.data) return;
  const box = $('#transcript');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const gaps = state.data.session.audio_gaps || [];
  const rows = [];
  for (const s of state.data.segments) {
    if (state.editing === s.id) {
      rows.push(`<div class="seg" id="seg-${s.id}"><span class="sid">S${s.seq}</span>
        <div><span class="who ch-${s.channel}">${esc(s.speaker)}</span>
          <textarea id="edit-text" rows="2">${esc(s.text)}</textarea>
          <div class="row"><button class="small primary" data-save="${s.id}">Salva correzione</button><button class="small" data-cancel>Annulla</button></div>
        </div><span></span></div>`);
      continue;
    }
    rows.push(`<div class="seg ${s.status === 'corrected' ? 'corrected' : ''}" id="seg-${s.id}">
      <span class="sid">S${s.seq}${s.version > 1 ? ` <span title="corretto">v${s.version}</span>` : ''}</span>
      <div><span class="who ch-${s.channel}">${esc(s.speaker)}</span>${esc(s.text)}</div>
      <span class="actions"><button class="small ghost" data-edit="${s.id}" title="Correggi la trascrizione">✎</button>${s.version > 1 ? `<button class="small ghost" data-hist="${s.id}" title="Storico versioni">⟲</button>` : ''}</span>
    </div>`);
  }
  for (const g of gaps) rows.push(`<div class="gap">⚠ Interruzione ${esc(g.channel)}${g.gap_ms ? ` di ${Math.round(g.gap_ms / 1000)} s` : ''}${g.reason ? ` — ${esc(g.reason)}` : ''}: la trascrizione potrebbe essere incompleta</div>`);
  for (const p of state.partials.values()) {
    rows.push(`<div class="seg partial"><span class="sid">…</span><div><span class="who ch-${p.channel}">${esc(p.speaker)}</span>${esc(p.text)}</div><span></span></div>`);
  }
  box.innerHTML = rows.join('') || '<p class="muted">Nessun parlato ancora. Avvia l\'audio o uno scenario demo.</p>';
  box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => { state.editing = b.dataset.edit; renderTranscript(); $('#edit-text')?.focus(); }; });
  box.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => { state.editing = null; renderTranscript(); }; });
  box.querySelectorAll('[data-save]').forEach((b) => { b.onclick = () => saveCorrection(b.dataset.save); });
  box.querySelectorAll('[data-hist]').forEach((b) => { b.onclick = () => showSegmentHistory(b.dataset.hist); });
  if (atBottom && !state.editing) box.scrollTop = box.scrollHeight;
}

async function saveCorrection(id) {
  const text = $('#edit-text').value;
  try {
    const r = await api(`/api/segments/${id}`, { method: 'PATCH', body: { text } });
    state.editing = null;
    toast(`Correzione salvata (v${r.version}). ${r.invalidated_items} elementi derivati marcati come superati e rianalizzati.`, 'ok');
    await refresh();
  } catch (err) { toast(err.message, 'high'); }
}

async function showSegmentHistory(id) {
  const h = await api(`/api/segments/${id}/history`);
  toast(h.map((v) => `v${v.version} (${v.author}): ${v.text}`).join('\n'));
}

function highlight(ids) {
  document.querySelectorAll('.seg.highlight').forEach((e) => e.classList.remove('highlight'));
  ids.forEach((id, i) => {
    const el = document.getElementById(`seg-${id}`);
    if (el) { el.classList.add('highlight'); if (i === 0) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  setTimeout(() => document.querySelectorAll('.seg.highlight').forEach((e) => e.classList.remove('highlight')), 3000);
}

function renderSuggestions() {
  const list = [...state.data.suggestions].reverse();
  const filled = new Set(state.data.items.filter((i) => i.kind === 'field' && i.status !== 'superato').map((i) => i.field_key));
  const answered = (s) => s.dedupe_key.startsWith('missing:') && filled.has(s.dedupe_key.slice(8));
  $('#suggestions').innerHTML = list.map((s) => `
    <li class="${s.priority} ${s.dismissed || answered(s) ? 'dismissed' : ''}">
      <span class="kind-icon">${answered(s) ? '✔' : s.kind === 'question' ? '❓' : s.priority === 'high' ? '⛔' : '⚠'}</span>
      <div><div>${esc(s.text)}${answered(s) ? ' <span class="small muted">(informazione emersa)</span>' : ''}</div>${s.reason ? `<div class="why">${esc(s.reason)}</div>` : ''}
        ${s.source_segment_ids.length ? `<div class="why"><a href="#" data-src="${s.source_segment_ids.join(',')}">fonte ${s.source_segment_ids.map(segLabel).join(', ')}</a></div>` : ''}</div>
      ${s.dismissed ? '' : `<button class="small ghost" data-dismiss="${s.id}" title="Ignora">✕</button>`}
    </li>`).join('') || '<li class="muted">Nessun suggerimento: compariranno solo quando giustificati dal template.</li>';
  $('#suggestions').querySelectorAll('[data-dismiss]').forEach((b) => {
    b.onclick = async () => { await api(`/api/suggestions/${b.dataset.dismiss}/dismiss`, { method: 'POST' }); refresh(); };
  });
  bindSources($('#suggestions'));
}

function bindSources(root) {
  root.querySelectorAll('[data-src]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); showTab('live'); highlight(a.dataset.src.split(',')); };
  });
}

function renderFields() {
  const { template, items } = state.data;
  const active = items.filter((i) => i.kind === 'field' && i.status !== 'superato');
  let covered = 0;
  $('#fields').innerHTML = template.fields.map((f) => {
    const vals = active.filter((i) => i.field_key === f.key);
    if (vals.length) covered++;
    const cell = vals.length
      ? vals.map((v) => `<div>${esc(v.value)} <span class="st st-${v.status}">${STATUS_LABEL[v.status]}</span>
          <a href="#" class="small" data-src="${v.source_segment_ids.join(',')}">${v.source_segment_ids.map(segLabel).join(',')}</a>
          ${v.due_date ? `<span class="small muted">→ ${v.due_date}</span>` : ''}</div>`).join('')
      : '<span class="muted small">non ancora emerso</span>';
    return `<tr><td title="${esc(f.question || '')}">${esc(f.label)}</td><td>${cell}</td></tr>`;
  }).join('');
  $('#completeness').textContent = template.fields.length ? `${covered}/${template.fields.length} punti emersi` : '';
  bindSources($('#fields'));
}

function itemHtml(i, { actions = true } = {}) {
  const sub = [
    `<span class="st st-${i.status}">${STATUS_LABEL[i.status]}</span>`,
    `<span>${esc(i.epistemic)} · ${CERTAINTY_LABEL[i.certainty] || i.certainty}</span>`,
    i.owner ? `<span>resp.: ${esc(i.owner)}</span>` : '',
    i.due_text ? `<span>scadenza: ${esc(i.due_text)}${i.due_date ? ` (${i.due_date})` : ' (da confermare)'}</span>` : '',
    i.conditions ? `<span>condizioni: ${esc(i.conditions)}</span>` : '',
    `<span title="confidenza qualitativa, non probabilità calibrata">conf. ${Math.round((i.confidence ?? 0) * 100)}%</span>`,
    `<span>${esc(i.extractor)} · ${esc(i.template_id)} v${i.template_version}</span>`,
  ].filter(Boolean).join('');
  return `<div class="item ${i.status}">
    <div class="content">${esc(i.content)}</div>
    <div class="sub">${sub}</div>
    ${i.status_reason ? `<div class="sub">ⓘ ${esc(i.status_reason)}</div>` : ''}
    <div class="quote" data-src="${i.source_segment_ids.join(',')}">«${esc(i.quote)}» — ${i.source_segment_ids.map(segLabel).join(', ')}</div>
    ${actions && i.status !== 'superato' ? `<div class="acts">
      ${i.status !== 'confermato' ? `<button class="small" data-status="confermato" data-item="${i.id}">✓ Conferma</button>` : ''}
      ${i.status !== 'contestato' ? `<button class="small" data-status="contestato" data-item="${i.id}">✗ Contesta</button>` : ''}
      <button class="small ghost" data-ihist="${i.id}">Storico</button>
    </div>` : ''}
  </div>`;
}

function renderItems() {
  const items = state.data.items.filter((i) => i.kind !== 'field');
  const groups = Object.keys(KIND_LABEL).map((k) => {
    const arr = items.filter((i) => i.kind === k);
    return arr.length ? `<div class="item-group"><h4>${KIND_LABEL[k]} (${arr.length})</h4>${arr.map((i) => itemHtml(i)).join('')}</div>` : '';
  }).join('');
  $('#items').innerHTML = groups || '<p class="muted">Ancora nulla. Gemma analizza i segmenti definitivi a piccoli gruppi, non ogni parola.</p>';
  bindItemActions($('#items'));
}

function bindItemActions(root) {
  root.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = async () => {
      try { await api(`/api/items/${b.dataset.item}`, { method: 'PATCH', body: { status: b.dataset.status } }); refresh(); } catch (err) { toast(err.message, 'high'); }
    };
  });
  root.querySelectorAll('[data-ihist]').forEach((b) => {
    b.onclick = async () => {
      const h = await api(`/api/items/${b.dataset.ihist}/history`);
      toast(h.map((x) => `${new Date(x.created_at).toLocaleTimeString('it-IT')} ${x.author}: ${JSON.stringify(x.change)}`).join('\n'));
    };
  });
  bindSources(root);
}

function renderReport() {
  const r = state.data.session.report;
  if (!r) {
    $('#report').innerHTML = '<p class="muted">Il report post-chiamata viene generato quando premi «Termina chiamata»: rilegge l\'intera trascrizione, consolida i dati e li confronta con le conversazioni precedenti dello stesso progetto.</p>';
    return;
  }
  const list = (arr) => arr.length ? arr.map((i) => itemHtml(i, { actions: false })).join('') : '<p class="muted">Nessuno</p>';
  const sec = (title, body) => `<div class="report-section"><h3>${title}</h3>${body}</div>`;
  $('#report').innerHTML = [
    sec(`Sintesi <span class="muted small">(${r.summary_source}${r.summary_source === 'gemma' ? ', da verificare' : ''})</span>`, `<p>${esc(r.summary)}</p>
      ${r.topics?.length ? `<p class="small muted">Argomenti: ${r.topics.map(esc).join(' · ')}</p>` : ''}
      <p class="small">Punti della traccia emersi: <b>${Math.round(r.completeness * 100)}%</b> · ${r.stats.segments} segmenti · ${r.stats.items} elementi · ${r.stats.gaps} interruzioni</p>`),
    sec('Traccia', `<table class="fields">${r.fields.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value ?? '—')} <span class="st st-${f.status}">${STATUS_LABEL[f.status]}</span></td></tr>`).join('')}</table>`),
    r.document_refs?.length ? sec('Confronto con i documenti di riferimento', `${r.document_refs.map((d) => `
      <div class="item"><div class="content">${esc(d.label)}: «${esc(d.value)}» <span class="small muted">(detto in chiamata)</span></div>
        <div class="chunk"><span class="sid">📄 ${esc(d.document_title)} · similarità ${d.similarity}</span>\n${esc(d.text)}</div></div>`).join('')}
      <p class="small muted">Passaggi dei documenti più vicini a ciascun valore, affiancati per la verifica umana: il sistema non decide da solo chi ha ragione.</p>`) : '',
    r.cross_session?.length ? sec('Confronto con conversazioni precedenti', `<ul>${r.cross_session.map((c) => `<li><b>${esc(c.field_key)}</b>: prima «${esc(c.previous.value)}» (${esc(c.previous.session_title)}) → ora «${esc(c.current.value)}» <span class="st st-${c.current.status}">${STATUS_LABEL[c.current.status]}</span></li>`).join('')}</ul><p class="small muted">Entrambe le versioni sono conservate; nessun dato precedente viene sovrascritto.</p>`) : '',
    sec('Da verificare prima di decidere', list(r.to_verify)),
    sec('Impegni', list(r.commitments)),
    sec('Decisioni', list(r.decisions)),
    r.contested.length ? sec('In conflitto', list(r.contested)) : '',
    sec('Domande aperte', list(r.open_questions)),
    r.risks.length ? sec('Rischi', list(r.risks)) : '',
    r.open_points?.length ? sec('Punti aperti (Gemma)', `<ul>${r.open_points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`) : '',
    r.needs_human_confirmation?.length ? sec('Richiede conferma umana (Gemma)', `<ul>${r.needs_human_confirmation.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`) : '',
    r.audio_gaps?.length ? sec('Interruzioni audio', `<ul>${r.audio_gaps.map((g) => `<li>${esc(g.channel)}: ${g.gap_ms ? Math.round(g.gap_ms / 1000) + ' s' : '?'} ${esc(g.reason || '')}</li>`).join('')}</ul>`) : '',
  ].join('');
  bindSources($('#report'));
}

async function downloadMarkdown(e) {
  e.preventDefault();
  const md = await api(`/api/sessions/${state.sessionId}/report.md`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `${state.data.session.title.replace(/[^\w-]+/g, '_')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --------------------------------------------------------------- tabs etc.

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === 'metrics') renderMetrics();
  if (name === 'templates') renderTemplates();
}

async function ask(e) {
  e.preventDefault();
  const scope = $('#ask-scope').value;
  $('#answer').innerHTML = '<p class="muted">Cerco nelle conversazioni…</p>';
  try {
    const r = await api('/api/ask', {
      method: 'POST',
      body: { question: $('#ask-q').value, session_id: scope === 'session' ? state.sessionId : null, project: scope === 'project' ? state.data.session.project : null },
    });
    $('#answer').innerHTML = answerHtml(r);
    bindEvidence($('#answer'));
  } catch (err) { $('#answer').innerHTML = `<p class="req">${esc(err.message)}</p>`; }
}

function evidenceHtml(list, cited = new Set()) {
  return `<ol class="evidence">${list.map((ev, idx) => `<li class="${cited.has(ev.id) ? 'cited' : ''}">
    <b>#${idx + 1}</b> <span class="src-tag src-${ev.kind}">${ev.kind}</span>${esc(ev.text)}
    <div class="small muted">${ev.kind === 'documento'
      ? `📄 ${esc(ev.document_title)}`
      : `${esc(ev.speaker)} · <a href="#" data-open-session="${ev.session_id}">${esc(ev.session_title)}</a>`}
      · ${new Date(ev.created_at).toLocaleString('it-IT')} · match ${esc(ev.match)}${ev.similarity != null ? ` (${ev.similarity})` : ''}</div></li>`).join('')}</ol>`;
}

function answerHtml(r) {
  return `<div class="answer">
    <div class="direct">${esc(r.answer)}</div>
    <p class="small">Evidenze sufficienti: <b>${r.sufficient_evidence ? 'sì' : 'no'}</b> · confidenza: <b>${esc(r.confidence)}</b>${r.confidence_reason ? ` — ${esc(r.confidence_reason)}` : ''} · modalità: ${esc(r.mode)}</p>
    ${r.missing_information?.length ? `<p class="small">Informazioni mancanti: ${r.missing_information.map(esc).join('; ')}</p>` : ''}
    ${r.evidence.length ? `<h3>Evidenze</h3>${evidenceHtml(r.evidence, new Set(r.citations))}` : ''}
    ${r.related_items?.length ? `<h3>Elementi collegati e stato di verifica</h3>${r.related_items.map((i) => itemHtml(i, { actions: false })).join('')}` : ''}
  </div>`;
}

function bindEvidence(root) {
  root.querySelectorAll('[data-open-session]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); openSession(a.dataset.openSession); };
  });
}

// ---------------------------------------------------------------- archive

async function openArchive() {
  closeSession();
  $('#empty').hidden = true;
  $('#archive').hidden = false;
  $('#btn-archive').classList.add('active');
  await loadProjects();
  renderDocuments();
}

function showArchiveTab(name) {
  document.querySelectorAll('.tabs button[data-atab]').forEach((b) => b.classList.toggle('active', b.dataset.atab === name));
  document.querySelectorAll('.atab').forEach((t) => { t.hidden = t.id !== `atab-${name}`; });
  if (name === 'docs') renderDocuments();
}

async function loadProjects() {
  const projects = await api('/api/projects');
  const sel = $('#gsearch-project');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Tutti i progetti</option>' + projects.map((p) => `<option value="${esc(p.project)}">${esc(p.project)} (${p.sessions} conv., ${p.documents} doc.)</option>`).join('');
  sel.value = cur;
  $('#project-list').innerHTML = projects.map((p) => `<option value="${esc(p.project)}">`).join('');
}

async function globalSearch(e) {
  e.preventDefault();
  const mode = e.submitter?.value || 'ask';
  const body = {
    project: $('#gsearch-project').value || null,
    include_conversations: $('#gsearch-conv').checked,
    include_documents: $('#gsearch-docs').checked,
  };
  const out = $('#gsearch-out');
  out.innerHTML = `<p class="muted">${mode === 'ask' ? 'Cerco le evidenze e chiedo a Gemma…' : 'Cerco…'}</p>`;
  try {
    if (mode === 'ask') {
      const r = await api('/api/ask', { method: 'POST', body: { ...body, question: $('#gsearch-q').value } });
      out.innerHTML = answerHtml(r);
    } else {
      const list = await api('/api/search', { method: 'POST', body: { ...body, query: $('#gsearch-q').value } });
      out.innerHTML = list.length ? `<div class="answer"><h3>${list.length} risultati</h3>${evidenceHtml(list)}</div>` : '<p class="muted">Nessun risultato.</p>';
    }
    bindEvidence(out);
  } catch (err) { out.innerHTML = `<p class="req">${esc(err.message)}</p>`; }
}

async function renderDocuments() {
  const docs = await api('/api/documents');
  $('#doc-count').textContent = `${docs.length}`;
  $('#doc-list').innerHTML = docs.map((d) => `
    <li data-doc="${d.id}">
      <div><b>${esc(d.title)}</b><div class="small muted">${esc(d.project)} · ${d.chunks} blocchi (${d.embedded} indicizzati) · ${Math.round(d.chars / 100) / 10}k caratteri${d.filename ? ` · ${esc(d.filename)}` : ''}</div></div>
      <button class="small ghost" data-del-doc="${d.id}" title="Elimina documento">✕</button>
    </li>`).join('') || '<li class="muted">Nessun documento. Aggiungine uno o carica i dati demo.</li>';
  $('#doc-list').querySelectorAll('li[data-doc]').forEach((li) => {
    li.onclick = async (e) => {
      if (e.target.closest('[data-del-doc]')) return;
      $('#doc-list').querySelectorAll('li').forEach((x) => x.classList.toggle('active', x === li));
      const d = await api(`/api/documents/${li.dataset.doc}`);
      $('#doc-view').innerHTML = `<h3 style="margin-top:14px">${esc(d.title)}</h3>${d.chunks.map((c) => `<div class="chunk"><span class="sid">blocco ${c.seq}</span>\n${esc(c.text)}</div>`).join('')}`;
    };
  });
  $('#doc-list').querySelectorAll('[data-del-doc]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Conferma'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = '✕'; }, 3000); return; }
      await api(`/api/documents/${b.dataset.delDoc}`, { method: 'DELETE' });
      $('#doc-view').innerHTML = '';
      toast('Documento e indici eliminati', 'ok');
      renderDocuments();
      loadProjects();
    };
  });
}

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

async function addDocument(e) {
  e.preventDefault();
  const f = e.target;
  const file = f.file.files[0];
  if (!file && !f.text.value.trim()) return toast('Scegli un file o incolla del testo', 'high');
  const btn = f.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Indicizzazione…';
  try {
    const body = { title: f.title.value || file?.name, project: f.project.value };
    if (file) Object.assign(body, { filename: file.name, mime: file.type, content_base64: await fileToBase64(file) });
    else body.text = f.text.value;
    const d = await api('/api/documents', { method: 'POST', body });
    toast(`Aggiunto «${d.title}»: ${d.chunks} blocchi, ${d.embedded} indicizzati semanticamente`, 'ok');
    f.reset();
    f.project.value = body.project;
    renderDocuments();
    loadProjects();
  } catch (err) { toast(err.message, 'high'); } finally {
    btn.disabled = false;
    btn.textContent = 'Aggiungi all\'archivio';
  }
}

async function importConversation(e) {
  e.preventDefault();
  const f = e.target;
  try {
    const s = await api('/api/sessions/import', {
      method: 'POST',
      body: {
        title: f.title.value, project: f.project.value, templateId: f.templateId.value, text: f.text.value,
        date: f.date.value ? new Date(f.date.value).toISOString() : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, consent: f.consent.checked,
      },
    });
    toast(`Importate ${s.lines} battute: elaborazione in corso`, 'ok');
    f.reset();
    await loadSessions();
    openSession(s.id); // watch the pipeline fill the cards live
  } catch (err) { toast(err.message, 'high'); }
}

async function seedDemo() {
  const btns = document.querySelectorAll('.seed-btn');
  btns.forEach((b) => { b.disabled = true; b.textContent = 'Caricamento…'; });
  const logEl = document.querySelectorAll('.seed-log');
  try {
    await api('/api/demo/seed', { method: 'POST' });
    for (;;) {
      const job = await api('/api/demo/seed');
      logEl.forEach((el) => { el.textContent = job.log.join('\n'); });
      if (!job.running) {
        if (job.error) throw new Error(job.error);
        toast(`Dati demo: ${job.result.documents} documenti e ${job.result.conversations} conversazioni caricati (${job.result.skipped} già presenti)`, 'ok');
        break;
      }
      await loadSessions();
      await new Promise((r) => setTimeout(r, 1500));
    }
    await loadSessions();
  } catch (err) { toast(err.message, 'high'); } finally {
    btns.forEach((b) => { b.disabled = false; b.textContent = 'Carica dati demo'; });
  }
}

async function renderMetrics() {
  const m = await api('/api/metrics');
  const names = {
    stt_partial_to_final_ms: 'STT: primo parziale → definitivo', persist_ms: 'Persistenza segmento', extraction_ms: 'Estrazione Gemma (batch)',
    rules_ms: 'Motore di regole', phrase_to_feedback_ms: 'Frase definitiva → feedback', ask_ms: 'Domanda all\'archivio',
  };
  const rows = Object.entries(m.latency).map(([k, v]) => `<tr><td>${esc(names[k] || k)}</td><td class="num">${v.n}</td><td class="num">${v.median_ms}</td><td class="num">${v.p95_ms}</td></tr>`).join('');
  $('#metrics').innerHTML = `<table class="metrics-table"><thead><tr><th>Metrica</th><th>n</th><th>mediana ms</th><th>p95 ms</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">Nessuna misura ancora</td></tr>'}</tbody></table>
    <h3 style="margin-top:16px">Output scartati (quarantena)</h3>
    <p>${Object.entries(m.quarantined_outputs).map(([k, v]) => `${esc(k)}: <b>${v}</b>`).join(' · ') || 'nessuno'}</p>
    <p class="small muted">«grounding» = estrazioni la cui citazione non compare nei segmenti indicati: non entrano mai nel database.</p>`;
}

async function renderTemplates(selectId) {
  state.templates = await api('/api/templates');
  $('#tpl-list').innerHTML = state.templates.map((t) => `<li data-id="${t.id}"><b>${esc(t.name)}</b><div class="small muted">${t.fields.length} punti · v${t.version}</div></li>`).join('');
  $('#tpl-list').querySelectorAll('li').forEach((li) => {
    li.onclick = () => fillTemplateForm(state.templates.find((t) => t.id === li.dataset.id));
  });
  $('#tpl-new').onclick = () => fillTemplateForm(null);
  $('#tpl-form').onsubmit = saveTemplate;
  const current = state.templates.find((t) => t.id === (selectId || $('#tpl-form').id.value)) || state.templates[0];
  fillTemplateForm(current);
}

function fillTemplateForm(t) {
  const f = $('#tpl-form');
  f.reset();
  $('#tpl-msg').textContent = '';
  $('#tpl-list').querySelectorAll('li').forEach((li) => li.classList.toggle('active', li.dataset.id === t?.id));
  f.id.readOnly = Boolean(t);
  if (!t) return f.nome.focus();
  f.nome.value = t.name;
  f.id.value = t.id;
  f.descrizione.value = t.description || '';
  f.obiettivo.value = t.goal || '';
  f.punti.value = t.fields.map((p) => (p.question ? `${p.label} | ${p.question}` : p.label)).join('\n');
  f.domande_generali.value = (t.guide_questions || []).join('\n');
}

async function saveTemplate(e) {
  e.preventDefault();
  const f = e.target;
  const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const body = {
    nome: f.nome.value.trim(),
    ...(f.id.value.trim() ? { id: f.id.value.trim() } : {}),
    descrizione: f.descrizione.value.trim(),
    obiettivo: f.obiettivo.value.trim(),
    punti: lines(f.punti.value).map((l) => {
      const [punto, ...rest] = l.split('|');
      const domanda = rest.join('|').trim();
      return domanda ? { punto: punto.trim(), domanda } : { punto: punto.trim() };
    }),
    domande_generali: lines(f.domande_generali.value),
  };
  try {
    const t = await api('/api/templates', { method: 'POST', body });
    state.templates = await api('/api/templates');
    const opts = state.templates.map((x) => `<option value="${x.id}">${esc(x.name)} (v${x.version})</option>`).join('');
    $('#template-select').innerHTML = opts;
    $('#live-template').innerHTML = opts;
    document.querySelectorAll('.tpl-options').forEach((s) => { s.innerHTML = opts; });
    await renderTemplates(t.id);
    $('#tpl-msg').textContent = `Salvato «${t.name}» v${t.version}`;
  } catch (err) { $('#tpl-msg').textContent = `Errore: ${err.message}`; }
}

boot().catch((e) => toast(e.message, 'high'));
