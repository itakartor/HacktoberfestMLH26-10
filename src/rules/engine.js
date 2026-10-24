import { detect, normalize } from '../extraction/linguistics.js';

const PRIORITY = { high: 3, medium: 2, low: 1 };

/**
 * Decides WHICH feedback to surface and WHEN. Alerts are generic system
 * behaviour, identical for every template. Questions come from Gemma, guided by
 * the template; the engine only filters them: one at a time, never on a point
 * already covered, never repeated within the cooldown (F13 / FC07).
 */
export class RuleEngine {
  constructor(template, opts = {}) {
    this.template = template;
    this.fieldCooldownMs = opts.fieldCooldownMs ?? 90000;
    this.minSegments = opts.minSegments ?? 3;
    this.maxPerMinute = opts.maxPerMinute ?? 3;
    this.now = opts.now ?? (() => Date.now());
  }

  evaluate({ segmentCount = 0, fieldStates = {}, newItems = [], newSegments = [], modelQuestions = [], conflicts = [], history = [], guideFallback = false }) {
    const candidates = [];
    const add = (s) => candidates.push({ source_segment_ids: [], bypassBudget: false, ...s });

    for (const seg of newSegments) {
      if (detect.injection(seg.text)) {
        add({ kind: 'alert', priority: 'high', rule_id: 'sys_injection', bypassBudget: true,
          text: 'Istruzione pronunciata nella chiamata: trattata come contenuto, nessuna azione eseguita.',
          reason: `«${seg.text.slice(0, 120)}»`, source_segment_ids: [seg.id], dedupe_key: `injection:${seg.id}` });
      }
      if (detect.selfCorrection(seg.text)) {
        add({ kind: 'alert', priority: 'medium', rule_id: 'sys_self_correction',
          text: 'Autocorrezione nel parlato: verificare che sia registrato il valore finale.',
          reason: `«${seg.text.slice(0, 120)}»`, source_segment_ids: [seg.id], dedupe_key: `selfcorr:${seg.id}` });
      }
    }

    for (const c of conflicts) {
      add({ kind: 'alert', priority: 'high', rule_id: 'sys_conflict', bypassBudget: true,
        text: c.isUpdate
          ? `Aggiornamento di «${c.label}»: ${c.oldValue} → ${c.newValue}. Il valore precedente è marcato come superato.`
          : `Valori in conflitto per «${c.label}»: ${c.oldValue} vs ${c.newValue}. Richiede conferma.`,
        reason: 'Entrambe le dichiarazioni sono conservate con le rispettive fonti.',
        source_segment_ids: c.source_segment_ids, dedupe_key: `conflict:${c.key}:${normalize(c.newValue)}` });
    }

    // An acceptance with conditions is never an agreement (FC03, case A).
    for (const it of newItems.filter((i) => i.kind === 'decision' && ['condizionato', 'ipotetico'].includes(i.certainty))) {
      add({ kind: 'alert', priority: 'high', rule_id: 'sys_conditional',
        text: 'Accettazione o decisione condizionata: registrata come NON definitiva finché le condizioni non sono verificate.',
        reason: it.content, source_segment_ids: it.source_segment_ids, dedupe_key: `cond:${normalize(it.content).slice(0, 60)}` });
    }

    const covered = (key) => Boolean(key && fieldStates[key]);
    const questionKey = (q) => (q.field_key ? `q:${q.field_key}` : `q:${normalize(q.text).slice(0, 60)}`);
    for (const q of modelQuestions) {
      if (covered(q.field_key)) continue; // the answer already emerged
      add({ kind: 'question', priority: 'low', rule_id: 'gemma_question', text: q.text, reason: q.reason,
        dedupe_key: questionKey(q), cooldownMs: this.fieldCooldownMs, group: 'question' });
    }
    // Without Gemma: offer the template's own guide question for the first uncovered point.
    if (guideFallback && segmentCount >= this.minSegments) {
      const f = this.template.fields.find((x) => x.question && !covered(x.key));
      if (f) add({ kind: 'question', priority: 'low', rule_id: 'guide_question', text: f.question,
        reason: `Punto della traccia non ancora emerso: ${f.label}`, dedupe_key: `q:${f.key}`, cooldownMs: this.fieldCooldownMs, group: 'question' });
    }

    return this.#select(candidates, history);
  }

  #select(candidates, history) {
    const now = this.now();
    const lastByKey = new Map();
    for (const h of history) {
      const ts = new Date(h.created_at).getTime();
      if (!lastByKey.has(h.dedupe_key) || lastByKey.get(h.dedupe_key) < ts) lastByKey.set(h.dedupe_key, ts);
    }
    const recent = history.filter((h) => now - new Date(h.created_at).getTime() < 60000 && h.priority !== 'high').length;
    let budget = Math.max(0, this.maxPerMinute - recent);

    // One candidate per dedupe key; the highest priority wins.
    const byKey = new Map();
    for (const c of candidates) {
      const prev = byKey.get(c.dedupe_key);
      if (!prev || PRIORITY[c.priority] > PRIORITY[prev.priority]) byKey.set(c.dedupe_key, c);
    }
    const out = [];
    const usedGroups = new Set(); // at most one question per evaluation: suggest, don't interrogate
    for (const c of [...byKey.values()].sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority])) {
      const last = lastByKey.get(c.dedupe_key);
      if (last !== undefined && now - last < (c.cooldownMs ?? Infinity)) continue; // alerts fire once per key
      if (c.group && usedGroups.has(c.group)) continue;
      if (!c.bypassBudget && c.priority !== 'high') {
        if (budget <= 0) continue;
        budget--;
      }
      if (c.group) usedGroups.add(c.group);
      const { cooldownMs, bypassBudget, group, ...s } = c;
      out.push(s);
    }
    return out;
  }
}
