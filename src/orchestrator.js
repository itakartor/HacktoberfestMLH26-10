import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { toVector } from './db.js';
import { RuleEngine } from './rules/engine.js';
import { extractWithLlm, extractWithRules, parseModelJson } from './extraction/extractor.js';
import { normalize, detect } from './extraction/linguistics.js';
import { AnswerOutputSchema, ReportOutputSchema, jsonSchemaOf } from './extraction/schema.js';
import { answerSystemPrompt, answerUserPrompt, reportSystemPrompt, reportUserPrompt } from './extraction/prompt.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const STATUSES = ['non_specificato', 'ambiguo', 'da_verificare', 'confermato', 'contestato', 'superato'];
const STOPWORDS = new Set('alla allo agli alle dalla dello della delle degli dove come cosa quale quali quando quanto questo questa quello quella sono siamo erano avevo aveva hanno abbiamo stato stata per con tra fra che chi non una uno del dei nel nei sul sui gli era'.split(' '));

/**
 * Central coordinator: sessions, transcript consolidation, extraction
 * scheduling, rules, persistence, search and reports. Every public method that
 * takes `ownerId` enforces isolation BEFORE touching data (TC16 / F16).
 */
export class Orchestrator {
  constructor({ db, bus, llm, templates }) {
    this.db = db;
    this.bus = bus;
    this.llm = llm;
    this.templates = templates;
    this.runtime = new Map(); // sessionId -> live state
    this.llmAvailable = null;
  }

  // ---------------------------------------------------------------- sessions

  async createSession(ownerId, { title, project = 'default', templateId = 'riunione', timezone = null, consent = false, context = null }) {
    const template = this.templates.get(templateId);
    if (!template) throw new HttpError(400, `template sconosciuto: ${templateId}`);
    if (!consent) throw new HttpError(400, 'Serve la conferma che i partecipanti sono informati e la registrazione è autorizzata.');
    const { rows } = await this.db.query(
      `INSERT INTO sessions (owner_id, project, title, context, template_id, template_version, template_history, timezone, consent_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING *`,
      [ownerId, project, title || 'Conversazione senza titolo', context, template.id, template.version,
        JSON.stringify([{ template_id: template.id, version: template.version, at: new Date().toISOString() }]), timezone],
    );
    return rows[0];
  }

  async getSession(ownerId, id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'sessione non trovata');
    const { rows } = await this.db.query('SELECT * FROM sessions WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (!rows[0]) throw new HttpError(404, 'sessione non trovata'); // same answer for "not yours" and "missing"
    return rows[0];
  }

  async listSessions(ownerId, project) {
    const { rows } = await this.db.query(
      `SELECT s.id, s.title, s.project, s.template_id, s.status, s.created_at, s.started_at, s.ended_at,
              (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id)::int AS segments
       FROM sessions s WHERE s.owner_id = $1 AND ($2::text IS NULL OR s.project = $2) ORDER BY s.created_at DESC`,
      [ownerId, project || null],
    );
    return rows;
  }

  async deleteSession(ownerId, id) {
    await this.getSession(ownerId, id);
    this.#dropRuntime(id);
    await this.db.query('DELETE FROM sessions WHERE id = $1 AND owner_id = $2', [id, ownerId]); // cascades to all derived data
  }

  async changeTemplate(ownerId, id, templateId) {
    const session = await this.getSession(ownerId, id);
    const template = this.templates.get(templateId);
    if (!template) throw new HttpError(400, `template sconosciuto: ${templateId}`);
    const history = [...session.template_history, { template_id: template.id, version: template.version, at: new Date().toISOString() }];
    await this.db.query('UPDATE sessions SET template_id = $2, template_version = $3, template_history = $4 WHERE id = $1',
      [id, template.id, template.version, JSON.stringify(history)]);
    const rt = this.runtime.get(id);
    if (rt) { rt.template = template; rt.engine = this.#engine(template); }
    return { template_id: template.id, version: template.version };
  }

  async startLive(sessionId, sources = []) {
    const { rows } = await this.db.query(
      `UPDATE sessions SET status = 'live', started_at = COALESCE(started_at, NOW()),
         audio_sources = $2 WHERE id = $1 RETURNING *`, [sessionId, JSON.stringify(sources)]);
    await this.#rt(sessionId);
    await this.bus.emit(sessionId, 'audio_started', { payload: { sources } });
    return rows[0];
  }

  async audioStopped(sessionId) {
    await this.bus.emit(sessionId, 'audio_stopped', {});
  }

  async connectionLost(sessionId, info) {
    const rt = await this.#rt(sessionId);
    rt.lostAt.set(info.channel ?? 'client', Date.now());
    await this.bus.emit(sessionId, 'connection_lost', { payload: info });
  }

  async connectionRestored(sessionId, info) {
    const rt = await this.#rt(sessionId);
    const key = info.channel ?? 'client';
    const lostAt = rt.lostAt.get(key);
    rt.lostAt.delete(key);
    const gap = { channel: key, from: lostAt ? new Date(lostAt).toISOString() : null, to: new Date().toISOString(), gap_ms: info.gap_ms ?? (lostAt ? Date.now() - lostAt : null) };
    await this.db.query(`UPDATE sessions SET audio_gaps = audio_gaps || $2::jsonb WHERE id = $1`, [sessionId, JSON.stringify([gap])]);
    await this.bus.emit(sessionId, 'connection_restored', { payload: gap });
  }

  /** Ends the call: flush live extraction, then run the post-call layer (B). */
  async completeSession(ownerId, id) {
    const session = await this.getSession(ownerId, id);
    if (session.status === 'completed' || session.status === 'processing') return session;
    await this.db.query(`UPDATE sessions SET status = 'processing', ended_at = NOW(), started_at = COALESCE(started_at, NOW()) WHERE id = $1`, [id]);
    await this.bus.emit(id, 'session_completed', { payload: { gaps: session.audio_gaps } });
    await this.flushExtraction(id);
    const report = await this.buildReport(id);
    this.#dropRuntime(id);
    return report;
  }

  // -------------------------------------------------------------- transcript

  async onPartial(sessionId, { channel, speaker, text }) {
    const rt = await this.#rt(sessionId);
    const ch = this.#channelState(rt, channel);
    if (!ch.firstPartialAt) ch.firstPartialAt = Date.now();
    return this.bus.emit(sessionId, 'transcript_partial', {
      segment_id: ch.provisionalId, speaker, payload: { text, channel, provisional: true },
    });
  }

  /**
   * Store a FINAL segment. Idempotent on `externalId`: replaying the same final
   * (reconnect, retry, simulator re-run) never creates duplicates (TC02/F02).
   */
  async onFinal(sessionId, { channel, speaker, text, externalId = null }) {
    const rt = await this.#rt(sessionId);
    const ch = this.#channelState(rt, channel);
    const receivedAt = Date.now();
    const id = `${sessionId.slice(0, 8)}-${externalId ?? `${channel}-${ch.counter}`}`;
    const replaces = ch.provisionalId;
    const startMs = ch.firstPartialAt && rt.startedAt ? ch.firstPartialAt - rt.startedAt : null;
    const t0 = performance.now();
    const { rows } = await this.db.query(
      `INSERT INTO segments (id, session_id, seq, speaker, channel, text, start_ms, end_ms)
       VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM segments WHERE session_id = $2), $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [id, sessionId, speaker, channel, text, startMs, rt.startedAt ? receivedAt - rt.startedAt : null],
    );
    ch.counter++;
    ch.provisionalId = `live-${channel}-${ch.counter}`;
    if (ch.firstPartialAt) this.#metric(sessionId, 'stt_partial_to_final_ms', receivedAt - ch.firstPartialAt);
    ch.firstPartialAt = null;
    if (!rows[0]) return null; // duplicate final
    const seg = rows[0];
    this.#metric(sessionId, 'persist_ms', performance.now() - t0);
    rt.receivedAt.set(seg.id, receivedAt);

    await this.bus.emit(sessionId, 'transcript_final', {
      event_id: `${sessionId}:final:${seg.id}`, segment_id: seg.id, speaker,
      payload: { text, channel, seq: seg.seq, start_ms: seg.start_ms, end_ms: seg.end_ms, replaces },
    });
    if (rt.lastSpeaker && rt.lastSpeaker !== speaker) {
      await this.bus.emit(sessionId, 'speaker_changed', { segment_id: seg.id, speaker, payload: { from: rt.lastSpeaker, to: speaker } });
    }
    rt.lastSpeaker = speaker;
    this.#embedSegment(seg).catch(() => {});
    this.scheduleExtraction(sessionId);
    return seg;
  }

  /** Manual correction with full history; derived data is re-evaluated (TC13/FC09). */
  async correctSegment(ownerId, segmentId, text, author) {
    const { rows } = await this.db.query(
      `SELECT g.* FROM segments g JOIN sessions s ON s.id = g.session_id WHERE g.id = $1 AND s.owner_id = $2`, [segmentId, ownerId]);
    const seg = rows[0];
    if (!seg) throw new HttpError(404, 'segmento non trovato');
    if (!text?.trim() || text.trim() === seg.text) throw new HttpError(400, 'testo corretto mancante o invariato');
    if (seg.version === 1) {
      await this.db.query('INSERT INTO segment_versions (segment_id, version, text, author, reason) VALUES ($1,1,$2,$3,$4)',
        [seg.id, seg.text, 'stt', 'trascrizione originale']);
    }
    const version = seg.version + 1;
    await this.db.query('INSERT INTO segment_versions (segment_id, version, text, author, reason) VALUES ($1,$2,$3,$4,$5)',
      [seg.id, version, text.trim(), author, 'correzione manuale']);
    await this.db.query(`UPDATE segments SET text = $2, version = $3, status = 'corrected', extraction_state = 'pending', embedding = NULL WHERE id = $1`,
      [seg.id, text.trim(), version]);

    const { rows: derived } = await this.db.query(
      `UPDATE items SET status = 'superato', status_reason = $2, updated_at = NOW()
       WHERE $1 = ANY(source_segment_ids) AND status <> 'superato' RETURNING id`,
      [seg.id, `fonte corretta (v${version}) da ${author}`]);
    for (const d of derived) {
      await this.#history(d.id, { status: 'superato', reason: 'trascrizione sorgente corretta', segment_id: seg.id, version }, author);
    }
    await this.bus.emit(seg.session_id, 'transcript_corrected', {
      segment_id: seg.id, speaker: seg.speaker,
      payload: { text: text.trim(), version, previous_text: seg.text, author, invalidated_items: derived.map((d) => d.id) },
    });
    this.#embedSegment({ ...seg, text: text.trim() }).catch(() => {});
    await this.#rt(seg.session_id);
    this.scheduleExtraction(seg.session_id, { immediate: true });
    return { id: seg.id, version, invalidated_items: derived.length };
  }

  async segmentHistory(ownerId, segmentId) {
    const { rows } = await this.db.query(
      `SELECT v.version, v.text, v.author, v.reason, v.created_at FROM segment_versions v
       JOIN segments g ON g.id = v.segment_id JOIN sessions s ON s.id = g.session_id
       WHERE v.segment_id = $1 AND s.owner_id = $2 ORDER BY v.version`, [segmentId, ownerId]);
    return rows;
  }

  // -------------------------------------------------------------- extraction

  scheduleExtraction(sessionId, { immediate = false } = {}) {
    const rt = this.runtime.get(sessionId);
    if (!rt) return;
    clearTimeout(rt.timer);
    const pendingCount = rt.pendingHint = (rt.pendingHint ?? 0) + 1;
    const delay = immediate || pendingCount >= config.extractionMaxBatch ? 0 : config.extractionDebounceMs;
    rt.timer = setTimeout(() => { this.runExtraction(sessionId).catch((e) => console.error('[extraction]', e)); }, delay);
    rt.timer.unref?.();
  }

  async flushExtraction(sessionId) {
    const rt = this.runtime.get(sessionId);
    if (rt) clearTimeout(rt.timer);
    while (rt?.running) await rt.running;
    await this.runExtraction(sessionId);
  }

  async runExtraction(sessionId) {
    const rt = await this.#rt(sessionId);
    if (rt.running) { rt.again = true; return rt.running; }
    rt.running = (async () => {
      try {
        do {
          rt.again = false;
          rt.pendingHint = 0;
          await this.#extractPending(sessionId, rt);
        } while (rt.again);
      } finally {
        rt.running = null;
      }
    })();
    return rt.running;
  }

  async #extractPending(sessionId, rt) {
    const { rows: pending } = await this.db.query(
      `SELECT * FROM segments WHERE session_id = $1 AND extraction_state = 'pending' ORDER BY seq LIMIT 6`, [sessionId]);
    if (!pending.length) return;
    const { rows: ctxRows } = await this.db.query(
      `SELECT * FROM segments WHERE session_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3`,
      [sessionId, pending[0].seq, config.contextWindowSegments]);
    const session = (await this.db.query('SELECT * FROM sessions WHERE id = $1', [sessionId])).rows[0];
    if (!session) return;
    const template = rt.template;

    // Short aliases (S12) for the model; mapped back to real ids afterwards.
    const alias = (s) => ({ ...s, id: `S${s.seq}` });
    const realId = new Map([...pending, ...ctxRows].map((s) => [`S${s.seq}`, s.id]));
    const fieldStates = await this.fieldStates(sessionId);
    const ctx = {
      template, session,
      newSegments: pending.map(alias),
      contextSegments: ctxRows.reverse().map(alias),
      knownFields: Object.fromEntries(Object.entries(fieldStates).map(([k, v]) => [k, `${v.value} (${v.status})`])),
    };

    const t0 = performance.now();
    let result;
    if (await this.#llmReady()) {
      try {
        result = await extractWithLlm(this.llm, ctx);
      } catch (err) {
        this.llmAvailable = null;
        result = { ok: false, failures: [{ raw: null, error: `LLM: ${err.message}` }] };
      }
    } else {
      result = { ok: false, failures: [] };
    }
    for (const f of result.failures ?? []) {
      await this.db.query('INSERT INTO quarantine (session_id, stage, raw, error) VALUES ($1,$2,$3,$4)', [sessionId, 'extraction', f.raw, f.error]);
    }
    if (!result.ok) {
      if (result.failures?.length) await this.bus.emit(sessionId, 'extraction_failed', { payload: { errors: result.failures.map((f) => f.error), fallback: 'regole' } });
      result = extractWithRules(ctx); // degrade, don't stop
    }
    this.#metric(sessionId, 'extraction_ms', performance.now() - t0);
    for (const r of result.rejected ?? []) {
      await this.db.query('INSERT INTO quarantine (session_id, stage, raw, error) VALUES ($1,$2,$3,$4)', [sessionId, 'grounding', JSON.stringify(r.entry), r.error]);
    }

    const mapIds = (ids) => ids.map((i) => realId.get(i) ?? i);
    const t1 = performance.now();
    const newItems = [];
    const conflicts = [];
    for (const it of result.items) {
      const saved = await this.#saveItem(sessionId, session, template, { ...it, source_segment_ids: mapIds(it.source_segment_ids) }, result.extractor);
      if (saved) newItems.push(saved);
    }
    for (const f of result.fields) {
      const { saved, conflict } = await this.#saveField(sessionId, session, template, { ...f, source_segment_ids: mapIds(f.source_segment_ids) }, result.extractor);
      if (saved) newItems.push(saved);
      if (conflict) conflicts.push(conflict);
    }

    await this.db.query(`UPDATE segments SET extraction_state = 'done' WHERE id = ANY($1)`, [pending.map((p) => p.id)]);

    // Events for derived information.
    for (const it of newItems) {
      await this.bus.emit(sessionId, 'information_extracted', { payload: { item: it } });
      if (it.kind === 'decision') await this.bus.emit(sessionId, 'decision_detected', { payload: { item: it } });
      if (it.kind === 'commitment') await this.bus.emit(sessionId, 'action_item_detected', { payload: { item: it } });
      if (this.#needsConfirmation(template, it)) {
        await this.bus.emit(sessionId, 'verification_required', { payload: { item_id: it.id, reason: it.status_reason || `«${it.field_key || it.kind}» richiede conferma umana`, content: it.content } });
      }
    }

    // Rules decide which feedback is worth showing now.
    const segCount = (await this.db.query('SELECT COUNT(*)::int AS n FROM segments WHERE session_id = $1', [sessionId])).rows[0].n;
    const { rows: history } = await this.db.query('SELECT dedupe_key, priority, created_at FROM suggestions WHERE session_id = $1', [sessionId]);
    const suggestions = rt.engine.evaluate({
      segmentCount: segCount,
      fieldStates: await this.fieldStates(sessionId),
      newItems,
      newSegments: pending,
      modelQuestions: result.questions ?? [],
      conflicts,
      history,
    });
    this.#metric(sessionId, 'rules_ms', performance.now() - t1);
    for (const s of suggestions) {
      const { rows } = await this.db.query(
        `INSERT INTO suggestions (session_id, kind, priority, text, reason, rule_id, source_segment_ids, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [sessionId, s.kind, s.priority, s.text, s.reason, s.rule_id, s.source_segment_ids, s.dedupe_key]);
      await this.bus.emit(sessionId, s.kind === 'question' ? 'question_suggested' : 'verification_required', { payload: { suggestion: rows[0] } });
    }
    const now = Date.now();
    for (const p of pending) {
      const at = rt.receivedAt.get(p.id);
      if (at) { this.#metric(sessionId, 'phrase_to_feedback_ms', now - at); rt.receivedAt.delete(p.id); }
    }

    const { rows: more } = await this.db.query(`SELECT 1 FROM segments WHERE session_id = $1 AND extraction_state = 'pending' LIMIT 1`, [sessionId]);
    if (more.length) rt.again = true;
  }

  #needsConfirmation(template, it) {
    const list = template.escalation.require_human_confirmation_for;
    const critical = template.fields.find((f) => f.key === it.field_key)?.critical;
    return it.status !== 'confermato' && (list.includes(it.kind) || list.includes(it.field_key) || critical);
  }

  async #saveItem(sessionId, session, template, it, extractor) {
    const dedupeKey = `${it.kind}:${normalize(it.content).slice(0, 80)}`;
    const { rows: dup } = await this.db.query(
      `SELECT id, source_segment_ids FROM items WHERE session_id = $1 AND dedupe_key = $2 AND status <> 'superato'`, [sessionId, dedupeKey]);
    if (dup[0]) {
      // Same information repeated: keep one item, accumulate sources (TC20).
      const merged = [...new Set([...dup[0].source_segment_ids, ...it.source_segment_ids])];
      await this.db.query('UPDATE items SET source_segment_ids = $2, updated_at = NOW() WHERE id = $1', [dup[0].id, merged]);
      return null;
    }
    return this.#insertItem(sessionId, session, template, { ...it, field_key: null, value: null }, extractor, dedupeKey);
  }

  async #saveField(sessionId, session, template, f, extractor) {
    const label = template.fields.find((x) => x.key === f.key)?.label ?? f.key;
    const { rows: existing } = await this.db.query(
      `SELECT * FROM items WHERE session_id = $1 AND kind = 'field' AND field_key = $2 AND status NOT IN ('superato') ORDER BY created_at DESC`,
      [sessionId, f.key]);
    const same = existing.find((e) => normalize(e.value) === normalize(f.value));
    if (same) {
      const merged = [...new Set([...same.source_segment_ids, ...f.source_segment_ids])];
      await this.db.query('UPDATE items SET source_segment_ids = $2, updated_at = NOW() WHERE id = $1', [same.id, merged]);
      return { saved: null, conflict: null };
    }
    const item = {
      kind: 'field', field_key: f.key, value: f.value, content: `${label}: ${f.value}`,
      epistemic: 'dichiarazione', certainty: f.certainty, status: f.status, status_reason: f.status_reason,
      confidence: f.confidence, owner: null, due_text: null, due_date: f.due_date, conditions: null,
      quote: f.quote, source_segment_ids: f.source_segment_ids,
    };
    let conflict = null;
    const prev = existing[0];
    if (prev) {
      // Never overwrite silently: an explicit update supersedes, otherwise both are contested (TC06/F09).
      const isUpdate = detect.update(f.quote) || detect.selfCorrection(f.quote);
      if (!isUpdate) {
        item.status = 'contestato';
        item.status_reason = `in conflitto con «${prev.value}» detto in precedenza`;
      }
      conflict = { key: f.key, label, oldValue: prev.value, newValue: f.value, isUpdate, source_segment_ids: [...prev.source_segment_ids, ...f.source_segment_ids] };
    }
    const saved = await this.#insertItem(sessionId, session, template, item, extractor, `field:${f.key}:${normalize(f.value)}`);
    if (prev) {
      const status = conflict.isUpdate ? 'superato' : 'contestato';
      const reason = conflict.isUpdate ? `aggiornato a «${f.value}»` : `in conflitto con «${f.value}»`;
      await this.db.query('UPDATE items SET status = $2, status_reason = $3, superseded_by = $4, updated_at = NOW() WHERE id = $1',
        [prev.id, status, reason, conflict.isUpdate ? saved.id : null]);
      await this.#history(prev.id, { status, reason, by_item: saved.id }, 'sistema');
    }
    return { saved, conflict };
  }

  async #insertItem(sessionId, session, template, it, extractor, dedupeKey) {
    const { rows } = await this.db.query(
      `INSERT INTO items (session_id, kind, field_key, content, value, epistemic, certainty, status, status_reason, confidence,
         owner, due_text, due_date, conditions, quote, source_segment_ids, template_id, template_version, extractor, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [sessionId, it.kind, it.field_key, it.content, it.value, it.epistemic, it.certainty, it.status, it.status_reason, it.confidence,
        it.owner, it.due_text, it.due_date, it.conditions, it.quote, it.source_segment_ids, template.id, template.version, extractor, dedupeKey]);
    await this.#history(rows[0].id, { created: true, status: it.status }, extractor);
    return this.#publicItem(rows[0]);
  }

  async updateItemStatus(ownerId, itemId, status, author, note) {
    if (!STATUSES.includes(status)) throw new HttpError(400, `stato non valido: ${status}`);
    const { rows } = await this.db.query(
      `UPDATE items i SET status = $3, status_reason = $4, updated_at = NOW()
       FROM sessions s WHERE i.id = $1 AND s.id = i.session_id AND s.owner_id = $2 RETURNING i.*`,
      [itemId, ownerId, status, note || `impostato da ${author}`]);
    if (!rows[0]) throw new HttpError(404, 'elemento non trovato');
    await this.#history(itemId, { status, note }, author);
    const item = this.#publicItem(rows[0]);
    await this.bus.emit(rows[0].session_id, 'information_extracted', { payload: { item, updated: true } });
    return item;
  }

  async itemHistory(ownerId, itemId) {
    const { rows } = await this.db.query(
      `SELECT h.change, h.author, h.created_at FROM item_history h JOIN items i ON i.id = h.item_id
       JOIN sessions s ON s.id = i.session_id WHERE h.item_id = $1 AND s.owner_id = $2 ORDER BY h.id`, [itemId, ownerId]);
    return rows;
  }

  async dismissSuggestion(ownerId, id) {
    await this.db.query(`UPDATE suggestions g SET dismissed = TRUE FROM sessions s WHERE g.id = $1 AND s.id = g.session_id AND s.owner_id = $2`, [id, ownerId]);
  }

  async fieldStates(sessionId) {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (field_key) field_key, value, status, source_segment_ids FROM items
       WHERE session_id = $1 AND kind = 'field' AND status <> 'superato' ORDER BY field_key, created_at DESC`, [sessionId]);
    return Object.fromEntries(rows.map((r) => [r.field_key, { value: r.value, status: r.status, source_segment_ids: r.source_segment_ids }]));
  }

  async getState(ownerId, id) {
    const session = await this.getSession(ownerId, id);
    const [segments, items, suggestions, quarantine] = await Promise.all([
      this.db.query('SELECT id, seq, speaker, channel, text, start_ms, end_ms, version, status, extraction_state, created_at FROM segments WHERE session_id = $1 ORDER BY seq', [id]),
      this.db.query('SELECT * FROM items WHERE session_id = $1 ORDER BY created_at', [id]),
      this.db.query('SELECT * FROM suggestions WHERE session_id = $1 ORDER BY created_at', [id]),
      this.db.query('SELECT COUNT(*)::int AS n FROM quarantine WHERE session_id = $1', [id]),
    ]);
    const template = this.templates.get(session.template_id, session.template_version);
    return {
      session, template,
      segments: segments.rows,
      items: items.rows.map((r) => this.#publicItem(r)),
      suggestions: suggestions.rows,
      quarantined: quarantine.rows[0].n,
    };
  }

  // ----------------------------------------------------------------- search

  /** Natural-language Q&A over the owner's archive, always with sources (TC11). */
  async ask(ownerId, question, { project = null, sessionId = null } = {}) {
    if (!question?.trim()) throw new HttpError(400, 'domanda mancante');
    if (sessionId) await this.getSession(ownerId, sessionId);
    const t0 = performance.now();
    const evidence = await this.#retrieve(ownerId, question, { project, sessionId });
    if (!evidence.length) {
      return { answer: 'Non ci sono evidenze sufficienti nell\'archivio per rispondere in modo affidabile.', sufficient_evidence: false, citations: [], evidence: [], related_items: [], confidence: 'bassa', mode: 'nessuna_evidenza' };
    }
    const segIds = evidence.map((e) => e.id);
    const { rows: related } = await this.db.query(
      `SELECT * FROM items WHERE source_segment_ids && $1::text[] ORDER BY created_at`, [segIds]);
    const relatedItems = related.map((r) => this.#publicItem(r));

    if (!(await this.#llmReady())) {
      return { answer: 'Gemma non disponibile: ecco le evidenze più pertinenti trovate (ricerca testuale/semantica).', sufficient_evidence: false, citations: segIds.slice(0, 3), evidence, related_items: relatedItems, confidence: 'bassa', mode: 'solo_evidenze' };
    }
    const aliased = evidence.map((e, i) => ({ ...e, id: `E${i + 1}` }));
    const back = new Map(aliased.map((e, i) => [e.id, evidence[i].id]));
    try {
      const raw = await this.llm.chatJson({ system: answerSystemPrompt(), user: answerUserPrompt(question, aliased), schema: jsonSchemaOf(AnswerOutputSchema) });
      const out = AnswerOutputSchema.parse(parseModelJson(raw));
      // Drop any citation the model invented.
      const citations = out.citations.map((c) => back.get(c)).filter(Boolean);
      this.#metric(null, 'ask_ms', performance.now() - t0);
      const answer = out.answer.replace(/\bE(\d+)\b/g, (_, n) => `#${n}`); // evidence numbering shown in the UI
      return { ...out, answer, sufficient_evidence: out.sufficient_evidence && citations.length > 0, citations, evidence, related_items: relatedItems, mode: 'gemma' };
    } catch (err) {
      await this.db.query('INSERT INTO quarantine (session_id, stage, raw, error) VALUES ($1,$2,$3,$4)', [sessionId, 'answer', null, err.message.slice(0, 500)]);
      return { answer: 'Risposta del modello non valida: mostro le evidenze trovate.', sufficient_evidence: false, citations: segIds.slice(0, 3), evidence, related_items: relatedItems, confidence: 'bassa', mode: 'solo_evidenze' };
    }
  }

  async #retrieve(ownerId, question, { project, sessionId }) {
    // Authorization filter is part of every query, applied BEFORE ranking.
    const scope = `s.owner_id = $1 AND ($2::text IS NULL OR s.project = $2) AND ($3::uuid IS NULL OR s.id = $3)`;
    const params = [ownerId, project, sessionId];
    const results = new Map();

    const words = normalize(question).split(' ').filter((w) => w.length > 3 && !STOPWORDS.has(w));
    if (words.length) {
      const patterns = words.map((w) => `%${w.slice(0, Math.max(4, w.length - 2))}%`);
      const { rows } = await this.db.query(
        `SELECT g.id, g.text, g.speaker, g.created_at, g.session_id, s.title AS session_title,
           (SELECT COUNT(*) FROM unnest($4::text[]) p WHERE g.text ILIKE p)::int AS hits
         FROM segments g JOIN sessions s ON s.id = g.session_id
         WHERE ${scope} AND g.text ILIKE ANY($4::text[]) ORDER BY hits DESC, g.created_at DESC LIMIT 12`,
        [...params, patterns]);
      for (const r of rows) results.set(r.id, { ...r, score: 0.15 + 0.15 * r.hits, match: 'testo' });
    }

    try {
      if (await this.#embedReady()) {
        const [qv] = await this.llm.embed([question], { kind: 'query' });
        const { rows } = await this.db.query(
          `SELECT g.id, g.text, g.speaker, g.created_at, g.session_id, s.title AS session_title,
             1 - (g.embedding <=> $4::vector) AS similarity
           FROM segments g JOIN sessions s ON s.id = g.session_id
           WHERE ${scope} AND g.embedding IS NOT NULL ORDER BY g.embedding <=> $4::vector LIMIT 12`,
          [...params, toVector(qv)]);
        for (const r of rows) {
          if (r.similarity < config.searchMinSimilarity) continue;
          const prev = results.get(r.id);
          results.set(r.id, { ...r, score: (prev?.score ?? 0) + Number(r.similarity), match: prev ? 'testo+semantica' : 'semantica' });
        }
      }
    } catch { /* semantic search is an enhancement; text search still works */ }

    return [...results.values()].sort((a, b) => b.score - a.score).slice(0, 8)
      .map(({ id, text, speaker, created_at, session_id, session_title, score, match, similarity }) =>
        ({ id, text, speaker, created_at, session_id, session_title, score: Number(score.toFixed(3)), match, similarity: similarity != null ? Number(Number(similarity).toFixed(3)) : null }));
  }

  // ----------------------------------------------------------------- report

  /** Post-call layer B: consolidation, cross-session comparison, report. */
  async buildReport(sessionId) {
    const session = (await this.db.query('SELECT * FROM sessions WHERE id = $1', [sessionId])).rows[0];
    const template = this.templates.get(session.template_id, session.template_version);
    const { rows: segments } = await this.db.query('SELECT id, seq, speaker, text FROM segments WHERE session_id = $1 ORDER BY seq', [sessionId]);
    const { rows: itemRows } = await this.db.query(`SELECT * FROM items WHERE session_id = $1 ORDER BY created_at`, [sessionId]);
    const items = itemRows.map((r) => this.#publicItem(r));
    const active = items.filter((i) => i.status !== 'superato');
    const fieldStates = await this.fieldStates(sessionId);

    // Compare with previous sessions of the same owner + project (TC06).
    const { rows: prior } = await this.db.query(
      `SELECT i.field_key, i.value, i.status, i.source_segment_ids, s.title, s.id AS session_id, s.created_at
       FROM items i JOIN sessions s ON s.id = i.session_id
       WHERE s.owner_id = $1 AND s.project = $2 AND s.id <> $3 AND i.kind = 'field' AND i.status <> 'superato'
       ORDER BY s.created_at DESC`, [session.owner_id, session.project, sessionId]);
    const crossSession = [];
    for (const [key, cur] of Object.entries(fieldStates)) {
      const p = prior.find((x) => x.field_key === key);
      if (p && normalize(p.value) !== normalize(cur.value)) {
        crossSession.push({ field_key: key, previous: { value: p.value, session_title: p.title, session_id: p.session_id, source_segment_ids: p.source_segment_ids }, current: { value: cur.value, status: cur.status, source_segment_ids: cur.source_segment_ids } });
      }
    }

    const report = {
      generated_at: new Date().toISOString(),
      template: { id: template.id, version: template.version, name: template.name },
      stats: { segments: segments.length, items: active.length, gaps: session.audio_gaps.length },
      audio_gaps: session.audio_gaps,
      fields: template.fields.map((f) => ({ key: f.key, label: f.label, required: f.required, ...(fieldStates[f.key] ?? { value: null, status: 'non_specificato', source_segment_ids: [] }) })),
      commitments: active.filter((i) => i.kind === 'commitment'),
      decisions: active.filter((i) => i.kind === 'decision'),
      open_questions: active.filter((i) => i.kind === 'open_question'),
      risks: active.filter((i) => i.kind === 'risk'),
      facts: active.filter((i) => i.kind === 'fact' || i.kind === 'need'),
      contested: items.filter((i) => i.status === 'contestato'),
      superseded: items.filter((i) => i.status === 'superato'),
      to_verify: active.filter((i) => i.status !== 'confermato' && this.#needsConfirmation(template, i)),
      cross_session: crossSession,
      completeness: template.fields.filter((f) => f.required).length
        ? template.fields.filter((f) => f.required && fieldStates[f.key]).length / template.fields.filter((f) => f.required).length : 1,
      summary: null, topics: [], open_points: [], needs_human_confirmation: [], summary_source: 'nessuna',
    };

    if (segments.length && (await this.#llmReady())) {
      let transcript = segments.map((s) => `[S${s.seq} | ${s.speaker}] ${s.text}`).join('\n');
      if (transcript.length > 14000) transcript = `[...trascrizione troncata, ultimi 14000 caratteri...]\n${transcript.slice(-14000)}`;
      try {
        const raw = await this.llm.chatJson({ system: reportSystemPrompt(), user: reportUserPrompt({ session, template, transcript, items: active }), schema: jsonSchemaOf(ReportOutputSchema) });
        Object.assign(report, ReportOutputSchema.parse(parseModelJson(raw)), { summary_source: 'gemma' });
      } catch (err) {
        await this.db.query('INSERT INTO quarantine (session_id, stage, raw, error) VALUES ($1,$2,$3,$4)', [sessionId, 'report', null, err.message.slice(0, 500)]);
      }
    }
    if (!report.summary) {
      report.summary = `${segments.length} segmenti; ${report.commitments.length} impegni, ${report.decisions.length} decisioni, ${report.open_questions.length} domande aperte. Sintesi generata senza LLM.`;
      report.summary_source = 'regole';
    }

    await this.db.query(`UPDATE sessions SET report = $2, status = 'completed' WHERE id = $1`, [sessionId, JSON.stringify(report)]);
    await this.bus.emit(sessionId, 'report_ready', { payload: { report } });
    return report;
  }

  // ---------------------------------------------------------------- metrics

  async metrics(ownerId) {
    const { rows } = await this.db.query(
      `SELECT m.name, m.value_ms FROM metrics m LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.session_id IS NULL OR s.owner_id = $1 ORDER BY m.id DESC LIMIT 5000`, [ownerId]);
    const by = {};
    for (const r of rows) (by[r.name] ??= []).push(Number(r.value_ms));
    const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
    const { rows: q } = await this.db.query(
      `SELECT stage, COUNT(*)::int AS n FROM quarantine q LEFT JOIN sessions s ON s.id = q.session_id WHERE q.session_id IS NULL OR s.owner_id = $1 GROUP BY stage`, [ownerId]);
    return {
      latency: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.length, median_ms: Math.round(pct(v, 0.5)), p95_ms: Math.round(pct(v, 0.95)) }])),
      quarantined_outputs: Object.fromEntries(q.map((r) => [r.stage, r.n])),
    };
  }

  // ------------------------------------------------------------ simulation

  /** Replays a scripted conversation as partial + final events (demo & tests). */
  async simulate(ownerId, sessionId, scenario, { wordMs = 90, pauseMs = 500 } = {}) {
    const session = await this.getSession(ownerId, sessionId);
    if (session.status === 'created') await this.startLive(sessionId, [{ channel: 'sim', label: 'Simulazione' }]);
    const run = async () => {
      for (const [i, line] of scenario.lines.entries()) {
        const channel = line.channel ?? (line.speaker === scenario.lines[0].speaker ? 'mic' : 'tab');
        const words = line.text.split(' ');
        for (let w = 1; w <= words.length; w += 2) {
          await this.onPartial(sessionId, { channel, speaker: line.speaker, text: words.slice(0, w).join(' ') });
          if (wordMs) await new Promise((r) => setTimeout(r, wordMs * 2));
        }
        await this.onFinal(sessionId, { channel, speaker: line.speaker, text: line.text, externalId: `${scenario.id}-${i + 1}` });
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
    };
    return run();
  }

  // --------------------------------------------------------------- recovery

  /** After a restart: resume pending extraction and unfinished reports (TC10). */
  async recover() {
    const { rows } = await this.db.query(`SELECT id, status FROM sessions WHERE status IN ('live','processing')`);
    for (const s of rows) {
      if (s.status === 'processing') {
        await this.flushExtraction(s.id);
        await this.buildReport(s.id);
        this.#dropRuntime(s.id);
      } else {
        await this.db.query(`UPDATE sessions SET audio_gaps = audio_gaps || $2::jsonb WHERE id = $1`,
          [s.id, JSON.stringify([{ channel: 'server', from: null, to: new Date().toISOString(), gap_ms: null, reason: 'riavvio del server: audio non acquisito nell\'intervallo' }])]);
        await this.#rt(s.id);
        this.scheduleExtraction(s.id, { immediate: true });
      }
    }
    // Backfill embeddings that failed while Ollama was down.
    this.backfillEmbeddings().catch(() => {});
    return rows.length;
  }

  async backfillEmbeddings() {
    if (!(await this.#embedReady())) return 0;
    const { rows } = await this.db.query('SELECT id, text FROM segments WHERE embedding IS NULL ORDER BY created_at LIMIT 200');
    for (const r of rows) await this.#embedSegment(r);
    return rows.length;
  }

  // ---------------------------------------------------------------- helpers

  async #rt(sessionId) {
    let rt = this.runtime.get(sessionId);
    if (rt) return rt;
    const s = (await this.db.query('SELECT template_id, template_version, started_at FROM sessions WHERE id = $1', [sessionId])).rows[0];
    if (!s) throw new HttpError(404, 'sessione non trovata');
    const template = this.templates.get(s.template_id, s.template_version);
    const { rows } = await this.db.query(
      `SELECT channel, COUNT(*)::int AS n FROM segments WHERE session_id = $1 GROUP BY channel`, [sessionId]);
    rt = {
      template, engine: this.#engine(template), timer: null, running: null, again: false,
      channels: new Map(), counters: Object.fromEntries(rows.map((r) => [r.channel, r.n])),
      lostAt: new Map(), receivedAt: new Map(), lastSpeaker: null,
      startedAt: s.started_at ? new Date(s.started_at).getTime() : Date.now(),
    };
    this.runtime.set(sessionId, rt);
    return rt;
  }

  #channelState(rt, channel) {
    if (!rt.channels.has(channel)) {
      const counter = (rt.counters[channel] ?? 0) + 1;
      rt.channels.set(channel, { counter, provisionalId: `live-${channel}-${counter}`, firstPartialAt: null });
    }
    return rt.channels.get(channel);
  }

  #engine(template) {
    return new RuleEngine(template, {
      cooldownMs: config.suggestionCooldownMs,
      fieldCooldownMs: config.fieldQuestionCooldownMs,
      minSegments: config.minSegmentsBeforeMissingQuestions,
    });
  }

  #dropRuntime(id) {
    const rt = this.runtime.get(id);
    if (rt) clearTimeout(rt.timer);
    this.runtime.delete(id);
  }

  async #llmReady() {
    if (this.llmAvailable !== null && Date.now() - this.llmCheckedAt < 15000) return this.llmAvailable.llm;
    this.llmAvailable = await this.llm.status();
    this.llmCheckedAt = Date.now();
    return this.llmAvailable.llm;
  }

  async #embedReady() {
    await this.#llmReady();
    return this.llmAvailable?.embed;
  }

  async #embedSegment(seg) {
    if (!(await this.#embedReady())) return;
    const [v] = await this.llm.embed([seg.text]);
    await this.db.query('UPDATE segments SET embedding = $2::vector WHERE id = $1', [seg.id, toVector(v)]);
  }

  #metric(sessionId, name, valueMs) {
    this.db.query('INSERT INTO metrics (session_id, name, value_ms) VALUES ($1,$2,$3)', [sessionId, name, valueMs]).catch(() => {});
  }

  async #history(itemId, change, author) {
    await this.db.query('INSERT INTO item_history (item_id, change, author) VALUES ($1,$2,$3)', [itemId, JSON.stringify(change), author]);
  }

  #publicItem(r) {
    const { embedding, dedupe_key, ...rest } = r;
    return rest;
  }

  newId() { return randomUUID(); }
}
