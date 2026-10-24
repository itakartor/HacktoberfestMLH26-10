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
export function processExtraction(raw, { template, session, newSegments, contextSegments = [] }) {
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

  const questions = parsed.questions.filter((q) => !q.field_key || fieldKeys.has(q.field_key));
  return { ok: true, items, fields, questions, rejected };
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

export function extractWithRules({ template, session, newSegments }) {
  const items = [];
  const fields = [];
  const dateCtx = { sessionStart: session.started_at, timezone: session.timezone };
  const fieldKeys = new Set(template.fields.map((f) => f.key));
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
      const money = sentence.match(MONEY)?.[0];
      if (money) {
        const key = /budget/i.test(sentence) && fieldKeys.has('budget') ? 'budget' : fieldKeys.has('prezzo') ? 'prezzo' : null;
        if (key) {
          const adj = adjustCertainty('certo', sentence, sentence);
          fields.push({ key, value: money, certainty: adj.certainty, status: statusFromCertainty(adj.certainty),
            status_reason: 'estrazione di riserva a regole', quote: sentence.trim(), source_segment_ids: [seg.id], due_date: null, confidence: 0.3 });
        }
      }
      if (due && /consegn/i.test(sentence) && fieldKeys.has('data_consegna')) {
        const adj = adjustCertainty('certo', sentence, sentence);
        fields.push({ key: 'data_consegna', value: due, certainty: adj.certainty, status: statusFromCertainty(adj.certainty),
          status_reason: 'estrazione di riserva a regole', quote: sentence.trim(), source_segment_ids: [seg.id], due_date: resolveDate(due, dateCtx), confidence: 0.3 });
      }
    }
  }
  return { ok: true, items, fields, questions: [], rejected: [], failures: [], extractor: 'regole' };
}
