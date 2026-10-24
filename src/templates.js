import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROOT } from './config.js';

/*
 * A template is a GUIDELINE for the call: a goal and a few points worth
 * covering, each with a guide question. Gemma adapts the questions to the
 * conversation and only proposes them when pertinent. Everything else (alerts,
 * confirmation, rate limits) is generic system behaviour, not template config.
 *
 *   { "id": "commerciale", "nome": "Trattativa commerciale",
 *     "obiettivo": "…",
 *     "punti": [ { "punto": "Prezzo", "domanda": "Il prezzo è confermato?" } ] }
 */

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

const PointSchema = z.object({
  punto: z.string().min(2).max(80),
  domanda: z.string().max(250).optional(),
  // optional overrides; normally inferred from the point name
  chiave: z.string().regex(/^[a-z0-9_]+$/).optional(),
  tipo: z.enum(['testo', 'data', 'importo', 'persona']).optional(),
  parole_chiave: z.array(z.string()).optional(),
});

export const TemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/).optional(),
  nome: z.string().min(2).max(80),
  descrizione: z.string().max(300).default(''),
  obiettivo: z.string().max(400).default(''),
  versione: z.number().int().positive().default(1),
  punti: z.array(PointSchema).min(1).max(15),
  domande_generali: z.array(z.string().max(250)).max(10).default([]),
});

// Type inference from the point name, plus synonyms used to spot the point
// in what was said even when the model does not link it explicitly.
const TYPE_RULES = [
  ['date', /\b(data|scadenza|quando|incontro|entro|deadline)\b/],
  ['money', /\b(prezzo|budget|costo|importo|compenso|tariffa|cifra)\b/],
  ['person', /\b(decisore|responsabile|referente|chi|cliente finale)\b/],
];
const TYPE_IT = { testo: 'text', data: 'date', importo: 'money', persona: 'person' };
const SYNONYMS = {
  consegna: ['consegna', 'consegnare', 'deadline', 'rilascio', 'online', 'pronto'],
  prezzo: ['prezzo', 'costo', 'preventivo', 'cifra', 'importo', 'costa'],
  budget: ['budget', 'spendere', 'spesa'],
  avvio: ['avvio', 'partire', 'partenza', 'iniziare', 'inizio'],
  decisore: ['decisore', 'approva', 'decide', 'firma', 'direzione'],
  incontro: ['ci sentiamo', 'ci vediamo', 'risentiamo', 'facciamo il punto', 'prossima call'],
  materiali: ['materiali', 'file', 'contenuti', 'testi', 'foto', 'immagini'],
  responsabile: ['responsabile', 'se ne occupa', 'coordina', 'referente'],
  alternative: ['alternativa', 'alternative', 'opzione', 'oppure'],
  vincoli: ['vincolo', 'vincoli', 'limite', 'non possiamo'],
  obiettivo: ['obiettivo', 'scopo', 'vorrei capire'],
};
const STOP = new Set(['della', 'delle', 'degli', 'dello', 'alla', 'dalla', 'sulla', 'nella', 'cosa', 'come', 'quale', 'quali']);
const GENERIC = new Set(['data', 'scadenza', 'prossimo', 'prossima', 'decisione', 'prendere']);

function inferField(p) {
  const name = p.punto.toLowerCase();
  const type = (p.tipo && TYPE_IT[p.tipo]) || TYPE_RULES.find(([, re]) => re.test(name))?.[0] || 'text';
  let words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));
  // "Data consegna" vs "Data avvio": generic words alone would match both.
  if (words.some((w) => !GENERIC.has(w))) words = words.filter((w) => !GENERIC.has(w));
  const keywords = p.parole_chiave ?? [...new Set(words.flatMap((w) => SYNONYMS[w] ?? [w]))];
  return { key: p.chiave || slug(p.punto), label: p.punto, question: p.domanda, type, keywords };
}

// Internal shape used by the rest of the code.
export function normalizeTemplate(raw) {
  const simple = raw.punti ? raw : legacyToSimple(raw);
  const t = TemplateSchema.parse(simple);
  const id = t.id || slug(t.nome);
  const fields = t.punti.map(inferField);
  return {
    id,
    name: t.nome,
    version: t.versione,
    description: t.descrizione,
    goal: t.obiettivo,
    guide_questions: t.domande_generali,
    fields,
    source: { ...t, id },
  };
}

// Templates saved before the simplification (v1 files, archived sessions).
function legacyToSimple(old) {
  return {
    id: old.id, nome: old.name, descrizione: old.description ?? '', obiettivo: old.goal ?? '', versione: old.version ?? 1,
    punti: (old.fields ?? []).map((f) => ({ punto: f.label, domanda: f.question, chiave: f.key })),
  };
}

const BUILTIN_DIR = path.join(ROOT, 'templates');

/**
 * Built-in templates ship with the code; templates saved from the UI go to a
 * separate user dir (a volume in Docker), so updating the app never hides new
 * built-in versions and never loses user edits. Same id: highest version wins.
 */
export class TemplateStore {
  constructor({ builtinDir = BUILTIN_DIR, userDir = process.env.TEMPLATES_DIR || BUILTIN_DIR } = {}) {
    this.dirs = [...new Set([builtinDir, userDir])];
    this.userDir = userDir;
    this.templates = new Map(); // id -> latest
    this.reload();
  }

  reload() {
    this.templates.clear();
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const t = normalizeTemplate(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
        const cur = this.templates.get(t.id);
        if (!cur || t.version > cur.version) this.templates.set(t.id, t);
      }
    }
  }

  list() {
    return [...this.templates.values()];
  }

  get(id, version) {
    const latest = this.templates.get(id);
    if (!latest) return null;
    if (!version || version === latest.version) return latest;
    for (const dir of this.dirs) {
      const archived = path.join(dir, 'archive', `${id}.v${version}.json`);
      if (existsSync(archived)) return normalizeTemplate(JSON.parse(readFileSync(archived, 'utf8')));
    }
    return latest;
  }

  // Saving an existing id archives the previous version and bumps the version.
  save(input) {
    const draft = normalizeTemplate({ ...input, versione: 1 });
    const prev = this.templates.get(draft.id);
    const t = normalizeTemplate({ ...draft.source, versione: prev ? prev.version + 1 : 1 });
    const archive = path.join(this.userDir, 'archive');
    mkdirSync(archive, { recursive: true });
    if (prev) writeFileSync(path.join(archive, `${prev.id}.v${prev.version}.json`), JSON.stringify(prev.source, null, 2));
    writeFileSync(path.join(this.userDir, `${t.id}.json`), JSON.stringify(t.source, null, 2));
    this.templates.set(t.id, t);
    return t;
  }
}
