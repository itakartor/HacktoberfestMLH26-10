import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, ROOT } from './config.js';
import { createDb } from './db.js';
import { EventBus } from './events.js';
import { OllamaClient } from './llm/ollama.js';
import { TemplateStore } from './templates.js';
import { Orchestrator, HttpError } from './orchestrator.js';
import { ElevenLabsChannel } from './stt/elevenlabs.js';
import { reportToMarkdown } from './report-md.js';
import { DocumentStore, extractText } from './documents.js';
import { loadScenarios, seedDemo } from './seed.js';

export { loadScenarios };

// Loopback, private networks and dot-less hostnames (docker-compose service
// names like "ollama") stay inside the controlled environment.
function isLocalHost(url) {
  const host = new URL(url).hostname;
  return host === 'localhost' || !host.includes('.') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === 'host.docker.internal';
}

const CHANNEL_LABELS = { mic: 'Io', tab: 'Interlocutore' };
const CHANNEL_BY_BYTE = ['mic', 'tab'];

export async function createApp({ db, llm = new OllamaClient(), templates = new TemplateStore() } = {}) {
  db ??= await createDb();
  const bus = new EventBus(db);
  const orch = new Orchestrator({ db, bus, llm, templates });
  const documents = new DocumentStore({ db, llm });
  orch.documents = documents;
  const app = express();
  const smallJson = express.json({ limit: '2mb' });
  const uploadJson = express.json({ limit: '25mb' }); // base64 file uploads
  app.use((req, res, next) => (req.path === '/api/documents' ? uploadJson : smallJson)(req, res, next));
  app.use(express.static(path.join(ROOT, 'public')));

  // Demo identity. Real deployments must replace this with authentication;
  // isolation is nonetheless enforced server-side on every query.
  const user = (req) => {
    const id = req.get('x-user-id');
    if (!id || !/^[a-z0-9_-]{2,32}$/.test(id)) throw new HttpError(401, 'utente mancante (header x-user-id)');
    return id;
  };
  const h = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      const status = err.status ?? (err.name === 'ZodError' ? 400 : 500);
      if (status === 500) console.error(err);
      res.status(status).json({ error: err.message });
    }
  };

  app.get('/api/health', h(async () => ({
    db: db.kind,
    stt: { provider: 'elevenlabs', model: config.sttModel, configured: Boolean(config.elevenLabsKey) },
    llm: { ...(await llm.status()), model: llm.model, embed_model: llm.embedModel },
    external_data_flows: [
      config.elevenLabsKey ? 'Audio → ElevenLabs (STT cloud, api.elevenlabs.io)' : null,
      isLocalHost(config.ollamaUrl) ? null : `Testo → Ollama remoto ${config.ollamaUrl}`,
    ].filter(Boolean),
  })));

  app.get('/api/users', h(async () => (await db.query('SELECT id, name FROM users ORDER BY id')).rows));
  app.get('/api/scenarios', h(async () => loadScenarios().map(({ id, title, template, description }) => ({ id, title, template, description }))));

  app.get('/api/templates', h(async () => templates.list()));
  app.get('/api/templates/:id', h(async (req) => templates.get(req.params.id) ?? (() => { throw new HttpError(404, 'template non trovato'); })()));
  app.post('/api/templates', h(async (req) => { user(req); return templates.save(req.body); }));

  app.get('/api/sessions', h(async (req) => orch.listSessions(user(req), req.query.project)));
  app.post('/api/sessions', h(async (req) => orch.createSession(user(req), req.body)));
  app.get('/api/sessions/:id', h(async (req) => orch.getState(user(req), req.params.id)));
  app.delete('/api/sessions/:id', h(async (req) => orch.deleteSession(user(req), req.params.id)));
  app.post('/api/sessions/:id/complete', h(async (req) => orch.completeSession(user(req), req.params.id)));
  app.post('/api/sessions/:id/report', h(async (req) => {
    await orch.getSession(user(req), req.params.id);
    return orch.buildReport(req.params.id); // regenerate (e.g. after corrections or when Gemma was unavailable)
  }));
  app.post('/api/sessions/:id/template', h(async (req) => orch.changeTemplate(user(req), req.params.id, req.body.template_id)));
  app.get('/api/sessions/:id/events', h(async (req) => {
    await orch.getSession(user(req), req.params.id);
    return (await db.query('SELECT * FROM events WHERE session_id = $1 ORDER BY seq', [req.params.id])).rows;
  }));
  app.get('/api/sessions/:id/report', h(async (req) => (await orch.getSession(user(req), req.params.id)).report));
  app.get('/api/sessions/:id/report.md', h(async (req, res) => {
    const st = await orch.getState(user(req), req.params.id);
    res.type('text/markdown').send(reportToMarkdown(st));
  }));
  app.post('/api/sessions/:id/simulate', h(async (req) => {
    const owner = user(req);
    const scenario = loadScenarios().find((s) => s.id === req.body.scenario);
    if (!scenario) throw new HttpError(404, 'scenario non trovato');
    orch.simulate(owner, req.params.id, scenario, { wordMs: req.body.fast ? 0 : 90, pauseMs: req.body.fast ? 0 : 600 })
      .catch((e) => console.error('[simulate]', e));
    return { started: scenario.id, lines: scenario.lines.length };
  }));

  app.patch('/api/segments/:id', h(async (req) => orch.correctSegment(user(req), req.params.id, req.body.text, user(req))));
  app.get('/api/segments/:id/history', h(async (req) => orch.segmentHistory(user(req), req.params.id)));
  app.patch('/api/items/:id', h(async (req) => orch.updateItemStatus(user(req), req.params.id, req.body.status, user(req), req.body.note)));
  app.get('/api/items/:id/history', h(async (req) => orch.itemHistory(user(req), req.params.id)));
  app.post('/api/suggestions/:id/dismiss', h(async (req) => orch.dismissSuggestion(user(req), req.params.id)));

  app.post('/api/ask', h(async (req) => orch.ask(user(req), req.body.question, {
    project: req.body.project || null, sessionId: req.body.session_id || null,
    includeConversations: req.body.include_conversations !== false, includeDocuments: req.body.include_documents !== false,
  })));
  app.post('/api/search', h(async (req) => orch.search(user(req), req.body.query, {
    project: req.body.project || null,
    includeConversations: req.body.include_conversations !== false, includeDocuments: req.body.include_documents !== false,
  })));

  app.get('/api/projects', h(async (req) => {
    const { rows } = await db.query(
      `SELECT project, SUM(s)::int AS sessions, SUM(d)::int AS documents FROM (
         SELECT project, 1 AS s, 0 AS d FROM sessions WHERE owner_id = $1
         UNION ALL SELECT project, 0, 1 FROM documents WHERE owner_id = $1) x
       GROUP BY project ORDER BY project`, [user(req)]);
    return rows;
  }));

  // Reference documents: { title, project, text } or { title, project, filename, content_base64 }.
  app.get('/api/documents', h(async (req) => documents.list(user(req), req.query.project || null)));
  app.get('/api/documents/:id', h(async (req) => documents.get(user(req), req.params.id)));
  app.delete('/api/documents/:id', h(async (req) => documents.delete(user(req), req.params.id)));
  app.post('/api/documents', h(async (req) => {
    const owner = user(req);
    const { title, project, filename, content_base64: b64, mime } = req.body;
    const text = b64 ? await extractText(Buffer.from(b64, 'base64'), filename) : req.body.text;
    return documents.add(owner, { title, project, text, filename: filename || null, mime: mime || null });
  }));

  // Past conversations from text ("Nome: frase" per line) through the full pipeline.
  app.post('/api/sessions/import', h(async (req) => orch.importTranscript(user(req), req.body)));

  // Demo data (samples/demo.json), run in background; poll GET for progress.
  const seedJobs = new Map();
  app.post('/api/demo/seed', h(async (req) => {
    const owner = user(req);
    if (seedJobs.get(owner)?.running) return seedJobs.get(owner);
    const job = { running: true, log: [], result: null, error: null };
    seedJobs.set(owner, job);
    seedDemo({ orch, documents, ownerId: owner, log: (m) => job.log.push(m) })
      .then((r) => { job.result = r; })
      .catch((e) => { job.error = e.message; console.error('[seed]', e); })
      .finally(() => { job.running = false; });
    return job;
  }));
  app.get('/api/demo/seed', h(async (req) => seedJobs.get(user(req)) ?? { running: false, log: [], result: null }));
  app.get('/api/metrics', h(async (req) => orch.metrics(user(req))));

  return { app, db, bus, orch, documents };
}

// One WebSocket per open session page: events out, audio + control in.
function attachLive(server, { orch, bus }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const lastSeen = new Map(); // sessionId -> disconnect timestamp while live

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const userId = url.searchParams.get('user');
    const sessionId = url.searchParams.get('session');
    let session;
    try {
      session = await orch.getSession(userId, sessionId);
    } catch {
      ws.close(4404, 'sessione non trovata');
      return;
    }
    const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    const unsubscribe = bus.subscribe(sessionId, (event) => send({ kind: 'event', event }));
    const channels = new Map();
    let audioActive = false;

    if (lastSeen.has(sessionId) && session.status === 'live') {
      await orch.connectionRestored(sessionId, { channel: 'client', gap_ms: Date.now() - lastSeen.get(sessionId) });
    }
    lastSeen.delete(sessionId);

    const stopAudio = async () => {
      for (const ch of channels.values()) ch.close();
      channels.clear();
      if (audioActive) await orch.audioStopped(sessionId);
      audioActive = false;
    };

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data);
        const ch = channels.get(CHANNEL_BY_BYTE[buf[0]]);
        if (ch) ch.sendPcm(buf.subarray(1));
        return;
      }
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      try {
        if (msg.type === 'start_audio') {
          await stopAudio();
          const wanted = (msg.channels ?? ['mic']).filter((c) => CHANNEL_LABELS[c]);
          for (const name of wanted) {
            const speaker = (name === 'tab' ? msg.remote_label : msg.local_label) || CHANNEL_LABELS[name];
            const ch = new ElevenLabsChannel({ channel: name });
            ch.on('ready', () => send({ kind: 'stt', channel: name, state: 'ready' }));
            ch.on('partial', (text) => orch.onPartial(sessionId, { channel: name, speaker, text }).catch(console.error));
            ch.on('final', (text) => orch.onFinal(sessionId, { channel: name, speaker, text }).catch(console.error));
            ch.on('lost', (info) => orch.connectionLost(sessionId, { channel: `stt-${name}`, ...info }).catch(console.error));
            ch.on('restored', (info) => orch.connectionRestored(sessionId, { channel: `stt-${name}`, ...info }).catch(console.error));
            ch.on('warning', (w) => send({ kind: 'stt', channel: name, state: 'warning', message: w }));
            ch.on('error', (err) => send({ kind: 'stt', channel: name, state: 'error', message: err.message }));
            ch.connect();
            channels.set(name, ch);
          }
          audioActive = true;
          await orch.startLive(sessionId, wanted.map((c) => ({ channel: c, label: CHANNEL_LABELS[c] })));
        } else if (msg.type === 'stop_audio') {
          await stopAudio();
        }
      } catch (err) {
        send({ kind: 'error', message: err.message });
      }
    });

    ws.on('close', async (code) => {
      unsubscribe();
      const wasActive = audioActive;
      await stopAudio().catch(() => {});
      // Unexpected drop during a live call: record it so gaps are visible (TC09).
      if (wasActive && code !== 1000) {
        lastSeen.set(sessionId, Date.now());
        await orch.connectionLost(sessionId, { channel: 'client', code }).catch(() => {});
      }
    });
  });
}

async function main() {
  const { app, orch, bus } = await createApp();
  const server = http.createServer(app);
  attachLive(server, { orch, bus });
  const recovered = await orch.recover();
  server.listen(config.port, () => {
    console.log(`\n  Conversation Intelligence → http://localhost:${config.port}`);
    console.log(`  STT: ElevenLabs ${config.sttModel} (${config.elevenLabsKey ? 'chiave configurata' : 'CHIAVE MANCANTE: usare la modalità demo'})`);
    console.log(`  LLM: ${config.llmModel} · embedding: ${config.embedModel} @ ${config.ollamaUrl}`);
    if (recovered) console.log(`  Ripristinate ${recovered} sessioni non concluse`);
  });
  // Warm the model so the first live extraction is not slowed by loading.
  orch.llm.chatJson({ system: 'Rispondi con JSON.', user: '{"ok":true}' }).catch(() => {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'src', 'server.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { attachLive };
