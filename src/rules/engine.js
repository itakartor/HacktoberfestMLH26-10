import { detect, normalize } from '../extraction/linguistics.js';

const PRIORITY = { high: 3, medium: 2, low: 1 };

/**
 * Deterministic rule engine (README §3 "Motore di regole"). It decides WHEN to
 * surface feedback; Gemma only proposes content. Dedupe + cooldown + per-minute
 * budget keep live suggestions from becoming noise (F13 / FC07).
 */
export class RuleEngine {
  constructor(template, opts = {}) {
    this.template = template;
    this.cooldownMs = opts.cooldownMs ?? 20000;
    this.fieldCooldownMs = opts.fieldCooldownMs ?? 90000;
    this.minSegments = opts.minSegments ?? 3;
    this.now = opts.now ?? (() => Date.now());
  }

  evaluate({ segmentCount = 0, fieldStates = {}, newItems = [], newSegments = [], modelQuestions = [], conflicts = [], history = [] }) {
    const t = this.template;
    const candidates = [];
    const add = (s) => candidates.push({ source_segment_ids: [], ...s, bypassBudget: s.bypassBudget ?? false });

    // Safety signals are always shown.
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

    for (const rule of t.rules) {
      const w = rule.when;
      if (segmentCount < (w.after_segments ?? 0)) continue;
      const base = { kind: rule.then.type, priority: rule.priority, rule_id: rule.id, text: rule.then.message };
      if (w.text_matches) {
        const re = new RegExp(w.text_matches, 'i');
        for (const seg of newSegments.filter((s) => re.test(s.text))) {
          add({ ...base, reason: `«${seg.text.slice(0, 120)}»`, source_segment_ids: [seg.id], dedupe_key: `rule:${rule.id}:${seg.id}` });
        }
      }
      if (w.kind) {
        for (const it of newItems.filter((i) => i.kind === w.kind && (!w.certainty_in || w.certainty_in.includes(i.certainty)))) {
          add({ ...base, reason: it.content, source_segment_ids: it.source_segment_ids, dedupe_key: `rule:${rule.id}:${normalize(it.content).slice(0, 60)}` });
        }
      }
      if (w.field) {
        const st = fieldStates[w.field];
        const status = st?.status ?? 'non_specificato';
        if (!w.status_in || w.status_in.includes(status)) {
          add({ ...base, reason: st ? `${st.value} (${status})` : 'non specificato', source_segment_ids: st?.source_segment_ids ?? [],
            dedupe_key: `rule:${rule.id}:${status}:${normalize(st?.value ?? '')}` });
        }
      }
    }

    const liveQuestions = t.feedback.live_questions && t.mode !== 'sintetica';
    if (liveQuestions && segmentCount >= this.minSegments) {
      for (const f of t.fields.filter((f) => f.required && !fieldStates[f.key])) {
        add({ kind: 'question', priority: f.critical ? 'medium' : 'low', rule_id: 'sys_missing_field',
          text: f.question || `Manca: ${f.label}`, reason: `Campo obbligatorio non ancora emerso: ${f.label}`,
          dedupe_key: `missing:${f.key}`, cooldownMs: this.fieldCooldownMs, group: 'missing' });
      }
    }
    if (liveQuestions) {
      for (const q of modelQuestions) {
        if (q.field_key && fieldStates[q.field_key]?.status === 'da_verificare') continue; // already answered
        add({ kind: 'question', priority: 'low', rule_id: 'gemma_question', text: q.text, reason: q.reason,
          dedupe_key: q.field_key ? `missing:${q.field_key}` : `q:${normalize(q.text).slice(0, 60)}`, cooldownMs: this.fieldCooldownMs, group: 'missing' });
      }
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
    const recentBudgeted = history.filter((h) => now - new Date(h.created_at).getTime() < 60000 && h.priority !== 'high').length;
    let budget = Math.max(0, this.template.feedback.max_live_suggestions_per_minute - recentBudgeted);

    // One candidate per dedupe key, highest priority wins (explicit conflict policy).
    const byKey = new Map();
    for (const c of candidates) {
      const prev = byKey.get(c.dedupe_key);
      if (!prev || PRIORITY[c.priority] > PRIORITY[prev.priority]) byKey.set(c.dedupe_key, c);
    }
    const sorted = [...byKey.values()].sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority]);
    const out = [];
    const usedGroups = new Set(); // at most one gap question per evaluation: ask, don't interrogate
    for (const c of sorted) {
      const last = lastByKey.get(c.dedupe_key);
      if (last !== undefined) {
        const cd = c.cooldownMs ?? Infinity; // non-question alerts fire once per key
        if (now - last < cd) continue;
      }
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
