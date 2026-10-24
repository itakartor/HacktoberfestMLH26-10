// Deterministic Italian-language guardrails applied on top of model output.
// They only make results MORE cautious; they never upgrade certainty.

// JS `\b` treats accented letters as non-word chars ("purché", "venerdì"),
// so whole-word matching uses Unicode letter lookarounds instead.
export const words = (alternatives) => new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, 'iu');

const HEDGES = words('credo|penso|forse|magari|dovrebbe|dovremmo|potrebbe|potremmo|potrei|probabilmente|più o meno|circa|verso|in linea di massima|indicativamente|non so|vediamo|si vedrà|ipoteticamente|presumibilmente');
const CONDITIONAL = words('se|purché|a condizione che|a patto che|solo se|sempre che|nel caso in cui|qualora');
const NEGATION = words('non|nessun[oa]?|mai|né');
const SELF_CORRECTION = /(?<!\p{L})(?:anzi|no,|o meglio|cioè|scusa,|mi correggo|ho sbagliato)/iu;
const UPDATE_MARKERS = words('spostat[ao]|rimandat[ao]|anticipat[ao]|cambiat[ao]|aggiornat[ao]|invece|non più|slittat[ao]|nuova data');
const INJECTION = /(ignora (tutte )?(le )?(regole|istruzioni)|dimentica (le )?(regole|istruzioni)|sei ora|agisci come|cancella (tutte )?(le )?(altre )?(conversazioni|sessioni|dati)|invia(le|li)? (a|all'indirizzo)|system prompt|prompt di sistema)/i;

export const detect = {
  hedge: (t) => HEDGES.test(t),
  conditional: (t) => CONDITIONAL.test(t),
  negation: (t) => NEGATION.test(t),
  selfCorrection: (t) => SELF_CORRECTION.test(t),
  update: (t) => UPDATE_MARKERS.test(t),
  injection: (t) => INJECTION.test(t),
};

// Never let the model claim more certainty than the words support.
export function adjustCertainty(certainty, quote, content = '') {
  const reasons = [];
  let c = certainty;
  if (c === 'certo' && detect.conditional(quote)) {
    c = 'condizionato';
    reasons.push('formulazione condizionale');
  }
  if (c === 'certo' && detect.hedge(quote)) {
    c = 'ambiguo';
    reasons.push('formulazione incerta');
  }
  if (detect.negation(quote) && !detect.negation(content) && c !== 'negato') {
    c = 'negato';
    reasons.push('negazione presente nella fonte ma non nel contenuto estratto');
  }
  return { certainty: c, reasons };
}

// Statement != fact: nothing is 'confermato' until a human confirms it.
export function statusFromCertainty(certainty) {
  if (certainty === 'certo' || certainty === 'negato') return 'da_verificare';
  return 'ambiguo';
}

export function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A quote is accepted only if it really occurs in the cited segments
// (exactly, or with >= 75% of its words in order-insensitive overlap).
export function quoteMatches(quote, sourceText) {
  const q = normalize(quote);
  const s = normalize(sourceText);
  if (!q) return false;
  if (s.includes(q)) return true;
  const qTokens = q.split(' ').filter((w) => w.length > 2);
  if (qTokens.length === 0) return false;
  const sTokens = new Set(s.split(' '));
  const hit = qTokens.filter((w) => sTokens.has(w)).length;
  return hit / qTokens.length >= 0.75;
}

// ---- Relative dates (TC17 / F07) ----------------------------------------
// Resolved against the SESSION date and timezone, never the server clock.

const WEEKDAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function sessionLocalDate(sessionStart, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(sessionStart));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

export function resolveDate(text, { sessionStart, timezone } = {}) {
  if (!text) return null;
  if (!sessionStart || !timezone) return null; // keep it relative + to confirm
  const t = normalize(text);
  let base;
  try { base = sessionLocalDate(sessionStart, timezone); } catch { return null; }

  if (/\bfine (del|di) mese\b|\bprossima settimana\b|\bprossimo mese\b|\bmese prossimo\b/.test(t)) return null; // genuinely vague
  if (/\bdopodomani\b/.test(t)) return iso(addDays(base, 2));
  if (/\bdomani\b/.test(t)) return iso(addDays(base, 1));
  if (/\boggi\b|\bstasera\b/.test(t)) return iso(base);

  const explicit = t.match(/\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?\b/);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = MONTHS.indexOf(explicit[2]);
    let year = explicit[3] ? Number(explicit[3]) : base.getUTCFullYear();
    let d = new Date(Date.UTC(year, month, day));
    if (!explicit[3] && d < addDays(base, -60)) d = new Date(Date.UTC(year + 1, month, day));
    return iso(d);
  }

  const numeric = t.match(/\b(\d{1,2})\s(\d{1,2})(?:\s(\d{2,4}))?\b/);
  if (numeric && /\b(il|entro|per|al|dal)\s\d/.test(t)) {
    const year = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : base.getUTCFullYear();
    const d = new Date(Date.UTC(year, Number(numeric[2]) - 1, Number(numeric[1])));
    if (!Number.isNaN(d.getTime())) return iso(d);
  }

  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) {
      const diff = (i - base.getUTCDay() + 7) % 7 || 7; // next occurrence, never today
      return iso(addDays(base, diff));
    }
  }
  return null;
}

export const MONEY = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d+))?\s*(?:euro|€|eur)\b|\b(mille|duemila|tremila|quattromila|cinquemila|diecimila|quindicimila|ventimila|trentamila|cinquantamila|centomila)\s*(?:euro)?\b/i;
