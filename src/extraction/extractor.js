import { ExtractionOutputSchema, jsonSchemaOf } from './schema.js';
import { extractionSystemPrompt, extractionUserPrompt } from './prompt.js';
import { adjustCertainty, statusFromCertainty, quoteMatches, resolveDate, detect, words, MONEY } from './linguistics.js';

const OUTPUT_JSON_SCHEMA = jsonSchemaOf(ExtractionOutputSchema);

export function parseModelJson(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(text);
}

// Ground every extraction in the segments it claims to come from.
function ground(entry, segmentsById, allowedIds) {
  let ids = entry.source_segment_ids.filter((id) => allowedIds.has(id));
  if (ids.length && quoteMatches(entry.quote, ids.map((id) => segmentsById.get(id).text).join(' '))) return ids;
  // The model cited the wrong segment: accept only if the quote is found elsewhere.
  ids = [...allowedIds].filter((id) => quoteMatches(entry.quote, segmentsById.get(id).text));
  return ids.length ? ids.slice(0, 2) : null;
}

const NULLISH = /^(null|none|n\/a|non[_ ]specificato|sconosciuto|-)?$/i;

// Re-extractions from CONTEXT segments are expected duplicates, not errors.
function fromContext(entry, contextSegments) {
  return contextSegments.some((s) => quoteMatches(entry.quote, s.text));
}

/**
 * Validate + post-process raw model output. Pure function (no I/O) so it can be
 * tested deterministically. Returns accepted items/fields plus rejections.
 */
export function processExtraction(raw, { template, session, newSegments, contextSegments = [], knownFields = {} }) {
  const rejected = [];
  let parsed;
  try {
    parsed = ExtractionOutputSchema.parse(typeof raw === 'string' ? parseModelJson(raw) : raw);
  } catch (err) {
    return { ok: false, error: `schema: ${err.message.slice(0, 500)}`, items: [], fields: [], questions: [], rejected };
  }

  const segmentsById = new Map([...contextSegments, ...newSegments].map((s) => [s.id, s]));
  const allowedIds = new Set(newSegments.map((s) => s.id));
  const fieldKeys = new Set(template.fields.map((f) => f.key));
  const dateCtx = { sessionStart: session.started_at, timezone: session.timezone };

  const items = [];
  const linked = []; // accepted items that the model linked to a guideline point
  for (const it of parsed.items) {
    const ids = ground(it, segmentsById, allowedIds);
    if (!ids) {
      if (!fromContext(it, contextSegments)) rejected.push({ entry: it, error: 'citazione non trovata nei segmenti sorgente' });
      continue;
    }
    const sourceText = ids.map((id) => segmentsById.get(id).text).join(' ');
    const adj = adjustCertainty(it.certainty, it.quote, it.content);
    const certainty = it.kind === 'open_question' ? it.certainty : adj.certainty;
    const reasons = [...adj.reasons];
    if (detect.selfCorrection(sourceText)) reasons.push('autocorrezione nel parlato: verificare il valore finale');
    items.push({
      kind: it.kind,
      content: it.content,
      epistemic: certainty === 'ipotetico' ? 'ipotesi' : it.epistemic,
      certainty,
      status: statusFromCertainty(certainty),
      status_reason: reasons.join('; ') || null,
      owner: certainty === 'certo' || certainty === 'negato' ? it.owner : (it.owner ? `proposto: ${it.owner}` : null),
      due_text: it.due,
      due_date: resolveDate(it.due, dateCtx),
      conditions: it.conditions,
      quote: it.quote,
      source_segment_ids: ids,
      confidence: confidenceFor(certainty, reasons),
    });
    linked.push({ link: it, item: items.at(-1) });
  }

  const fields = [];
  for (const f of parsed.fields) {
    if (NULLISH.test(f.value.trim()) || NULLISH.test(f.quote.trim())) continue; // "not said" is not a value
    if (!fieldKeys.has(f.key)) { rejected.push({ entry: f, error: `campo non previsto dal template: ${f.key}` }); continue; }
    const ids = ground(f, segmentsById, allowedIds);
    if (!ids) {
      if (!fromContext(f, contextSegments)) rejected.push({ entry: f, error: 'citazione non trovata nei segmenti sorgente' });
      continue;
    }
    const adj = adjustCertainty(f.certainty, f.quote, f.value);
    const sourceText = ids.map((id) => segmentsById.get(id).text).join(' ');
    const reasons = [...adj.reasons];
    if (detect.selfCorrection(sourceText)) reasons.push('autocorrezione nel parlato: verificare il valore finale');
    fields.push({
      key: f.key,
      value: f.value,
      certainty: adj.certainty,
      status: statusFromCertainty(adj.certainty),
      status_reason: reasons.join('; ') || null,
      quote: f.quote,
      source_segment_ids: ids,
      due_date: resolveDate(f.value, dateCtx),
      confidence: confidenceFor(adj.certainty, reasons),
    });
  }

  // Points of the guideline answered by an extracted statement (preferred path).
  for (const { link, item } of linked) {
    if (!link.field_key || !link.value || NULLISH.test(link.value.trim())) continue;
    if (!fieldKeys.has(link.field_key) || fields.some((f) => f.key === link.field_key)) continue;
    fields.push(fieldFrom(link.field_key, link.value, item, dateCtx));
  }
  // Safety net: the model may extract "la consegna è il 20 dicembre" without
  // linking it to the point. Fill only points still unknown, from a sentence
  // that names the point AND contains a value of the right type.
  const known = new Set([...Object.keys(knownFields), ...fields.map((f) => f.key)]);
  for (const f of template.fields.filter((x) => !known.has(x.key))) {
    const hit = findTypedValue(f, newSegments);
    if (!hit) continue;
    const adj = adjustCertainty('certo', hit.sentence, hit.sentence);
    fields.push({
      key: f.key, value: hit.value, certainty: adj.certainty, status: statusFromCertainty(adj.certainty),
      status_reason: ['collegato alla traccia dal sistema', ...adj.reasons].join('; '), quote: hit.sentence,
      source_segment_ids: [hit.segmentId], due_date: f.type === 'date' ? resolveDate(hit.value, dateCtx) : null,
      confidence: confidenceFor(adj.certainty, adj.reasons) - 0.1,
    });
  }

  const questions = parsed.questions.filter((q) => !q.field_key || fieldKeys.has(q.field_key));
  return { ok: true, items, fields, questions, rejected };
}

function fieldFrom(key, value, item, dateCtx) {
  return {
    key, value, certainty: item.certainty, status: item.status, status_reason: item.status_reason,
    quote: item.quote, source_segment_ids: item.source_segment_ids, due_date: resolveDate(value, dateCtx), confidence: item.confidence,
  };
}

const DATE_VALUE = words('\\d{1,2} (?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?: \\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|dopodomani|domani|fine (?:del )?mese|(?:il )?mese prossimo|prossima settimana');

/** Value of the point's type closest to one of its keywords, within one sentence. */
export function findTypedValue(field, segments) {
  const pattern = field.type === 'date' ? DATE_VALUE : field.type === 'money' ? MONEY : null;
  if (!pattern || !field.keywords.length) return null;
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  for (const seg of segments) {
    for (const sentence of seg.text.split(/(?<=[.!?])\s+/)) {
      const lower = sentence.toLowerCase();
      const kwPos = field.keywords.map((k) => lower.indexOf(k.toLowerCase())).filter((p) => p >= 0);
      if (!kwPos.length) continue;
      const values = [...sentence.matchAll(global)];
      if (!values.length) continue;
      const best = values.reduce((a, b) => (Math.min(...kwPos.map((p) => Math.abs(p - b.index))) < Math.min(...kwPos.map((p) => Math.abs(p - a.index))) ? b : a));
      return { value: best[0].trim(), sentence: sentence.trim(), segmentId: seg.id };
    }
  }
  return null;
}

// Qualitative, explained confidence; not a calibrated probability (F22).
function confidenceFor(certainty, reasons) {
  const base = { certo: 0.8, negato: 0.7, condizionato: 0.55, ambiguo: 0.4, ipotetico: 0.35 }[certainty] ?? 0.5;
  return Math.max(0.1, base - 0.1 * reasons.length);
}

export async function extractWithLlm(llm, ctx, { retries = 1 } = {}) {
  const system = extractionSystemPrompt();
  const user = extractionUserPrompt(ctx);
  const failures = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await llm.chatJson({ system, user, schema: OUTPUT_JSON_SCHEMA });
    const result = processExtraction(raw, ctx);
    if (result.ok) return { ...result, failures, extractor: 'gemma' };
    failures.push({ raw, error: result.error });
  }
  return { ok: false, items: [], fields: [], questions: [], rejected: [], failures, extractor: 'gemma' };
}

// ---- Fallback when Gemma is unavailable: conservative regex extraction ----

const COMMITMENT = /\b(ti|vi|le|gli) (invio|mando|preparo|giro|faccio sapere|chiamo|scrivo)\b|\bmi occupo\b|\bfaccio io\b|\bci (sentiamo|vediamo|aggiorniamo)\b|\bentro\b/i;
const DECISION = /\b(abbiamo deciso|decidiamo|accetto|accettiamo|approvo|approviamo|confermo|confermiamo|rifiuto|non approvo)\b/i;
const RISK = /\b(rischio|ritard\w*|problema|bloccat\w*|critic\w*)\b/i;
const DUE = words('(?:entro (?:il |la |lo )?)?(?:lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|dopodomani|domani|fine (?:del )?mese|\\d{1,2} (?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre))');

export function extractWithRules({ template, session, newSegments, knownFields = {} }) {
  const items = [];
  const fields = [];
  const dateCtx = { sessionStart: session.started_at, timezone: session.timezone };
  for (const f of template.fields.filter((x) => !(x.key in knownFields))) {
    const hit = findTypedValue(f, newSegments);
    if (!hit) continue;
    const adj = adjustCertainty('certo', hit.sentence, hit.sentence);
    fields.push({ key: f.key, value: hit.value, certainty: adj.certainty, status: statusFromCertainty(adj.certainty),
      status_reason: 'estrazione di riserva a regole', quote: hit.sentence, source_segment_ids: [hit.segmentId],
      due_date: f.type === 'date' ? resolveDate(hit.value, dateCtx) : null, confidence: 0.3 });
  }
  for (const seg of newSegments) {
    for (const sentence of seg.text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3)) {
      const due = sentence.match(DUE)?.[0] ?? null;
      let kind = null;
      if (sentence.trim().endsWith('?')) kind = 'open_question';
      else if (DECISION.test(sentence)) kind = 'decision';
      else if (COMMITMENT.test(sentence)) kind = 'commitment';
      else if (RISK.test(sentence)) kind = 'risk';
      if (kind) {
        const adj = adjustCertainty('certo', sentence, sentence);
        items.push({
          kind, content: sentence.trim(), epistemic: 'dichiarazione', certainty: adj.certainty,
          status: statusFromCertainty(adj.certainty), status_reason: ['estrazione di riserva a regole', ...adj.reasons].join('; '),
          owner: null, due_text: due, due_date: resolveDate(due, dateCtx), conditions: null,
          quote: sentence.trim(), source_segment_ids: [seg.id], confidence: 0.3,
        });
      }
    }
  }
  return { ok: true, items, fields, questions: [], rejected: [], failures: [], extractor: 'regole' };
}
