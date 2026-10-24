import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from './config.js';

// Versioned event contract (README §4). Same shape on the wire and in the DB.
export const EVENT_TYPES = [
  'audio_started', 'audio_stopped', 'transcript_partial', 'transcript_final', 'transcript_corrected',
  'speaker_changed', 'information_extracted', 'verification_required', 'question_suggested',
  'decision_detected', 'action_item_detected', 'connection_lost', 'connection_restored',
  'extraction_failed', 'session_completed', 'report_ready',
];

// Partials are ephemeral by design: broadcast, never persisted.
const EPHEMERAL = new Set(['transcript_partial']);

export class EventBus {
  constructor(db) {
    this.db = db;
    this.seq = new Map(); // sessionId -> last seq
    this.subscribers = new Map(); // sessionId -> Set<fn>
  }

  subscribe(sessionId, fn) {
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId).add(fn);
    return () => this.subscribers.get(sessionId)?.delete(fn);
  }

  async #nextSeq(sessionId) {
    if (!this.seq.has(sessionId)) {
      const { rows } = await this.db.query('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = $1', [sessionId]);
      this.seq.set(sessionId, Number(rows[0].m));
    }
    const n = this.seq.get(sessionId) + 1;
    this.seq.set(sessionId, n);
    return n;
  }

  /** Emit an event. `event_id` may be supplied for idempotency (duplicates are dropped). */
  async emit(sessionId, type, { event_id, segment_id = null, speaker = null, payload = {}, processing_state = 'done' } = {}) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type ${type}`);
    const event = {
      event_id: event_id ?? randomUUID(),
      session_id: sessionId,
      seq: EPHEMERAL.has(type) ? null : await this.#nextSeq(sessionId),
      ts: new Date().toISOString(),
      type,
      schema_version: SCHEMA_VERSION,
      segment_id,
      speaker,
      payload,
      processing_state,
    };
    if (!EPHEMERAL.has(type)) {
      const { rows } = await this.db.query(
        `INSERT INTO events (event_id, session_id, seq, type, schema_version, segment_id, speaker, payload, processing_state, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.event_id, sessionId, event.seq, type, SCHEMA_VERSION, segment_id, speaker, JSON.stringify(payload), processing_state, event.ts],
      );
      if (rows.length === 0) return null; // duplicate: idempotent no-op
    }
    for (const fn of this.subscribers.get(sessionId) ?? []) {
      try { fn(event); } catch { /* a broken subscriber must not break the pipeline */ }
    }
    return event;
  }
}
