import { createDb } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { TemplateStore } from '../src/templates.js';
import { Orchestrator } from '../src/orchestrator.js';

/**
 * Deterministic stand-in for Gemma. `respond(ctx)` receives the user prompt and
 * returns the raw string the "model" would emit, so tests can also simulate
 * malformed output (TC14).
 */
export class FakeLlm {
  constructor(respond = () => '{"items":[],"fields":[],"questions":[]}', { available = true } = {}) {
    this.respond = respond;
    this.available = available;
    this.calls = [];
    this.model = 'fake-gemma';
    this.embedModel = 'none';
  }

  async chatJson({ system, user }) {
    this.calls.push({ system, user });
    return this.respond({ system, user, n: this.calls.length });
  }

  async embed() { throw new Error('no embeddings in tests'); }

  async status() { return { reachable: this.available, llm: this.available, embed: false, models: [] }; }
}

export async function setup(llm = new FakeLlm()) {
  const db = await createDb({ inMemory: true });
  const bus = new EventBus(db);
  const templates = new TemplateStore();
  const orch = new Orchestrator({ db, bus, llm, templates });
  const events = [];
  const session = async (owner = 'luca', opts = {}) => {
    const s = await orch.createSession(owner, { title: 't', templateId: 'commerciale', timezone: 'Europe/Rome', consent: true, ...opts });
    bus.subscribe(s.id, (e) => events.push(e));
    await orch.startLive(s.id, []);
    return s;
  };
  return { db, bus, orch, templates, llm, events, session };
}

export const extraction = ({ items = [], fields = [], questions = [] } = {}) => JSON.stringify({ items, fields, questions });

/** Segment alias shown to the model is S<seq>; tests use it to cite sources. */
export const item = (over = {}) => ({
  kind: 'commitment', content: 'inviare il preventivo', epistemic: 'dichiarazione', certainty: 'certo',
  owner: null, due: null, conditions: null, source_segment_ids: ['S1'], quote: 'invio il preventivo', ...over,
});
