import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processExtraction, extractWithRules } from '../src/extraction/extractor.js';
import { TemplateStore } from '../src/templates.js';
import { extraction, item } from './helpers.js';

const template = new TemplateStore().get('commerciale');
const session = { started_at: '2026-10-24T10:00:00Z', timezone: 'Europe/Rome' };
const seg = (seq, text, speaker = 'Io') => ({ id: `S${seq}`, seq, speaker, text });

test('TC14 malformed JSON is rejected, never persisted', () => {
  const r = processExtraction('{"items": [ {"kind": "commitment"', { template, session, newSegments: [seg(1, 'x')] });
  assert.equal(r.ok, false);
  assert.match(r.error, /schema/);
});

test('TC14 wrong types / missing fields are rejected', () => {
  const r = processExtraction(JSON.stringify({ items: [{ kind: 'boh', content: 1 }], fields: [], questions: [] }), { template, session, newSegments: [seg(1, 'x')] });
  assert.equal(r.ok, false);
});

test('TC03 commitment with deadline resolved against the session date', () => {
  const r = processExtraction(extraction({ items: [item({ due: 'venerdì', quote: 'Ti invio il preventivo entro venerdì' })] }), {
    template, session, newSegments: [seg(1, 'Ti invio il preventivo entro venerdì e poi ci sentiamo lunedì per decidere.')],
  });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].due_text, 'venerdì');
  assert.equal(r.items[0].due_date, '2026-10-30');
  assert.equal(r.items[0].status, 'da_verificare');
});

test('invented citations are rejected (no fabricated sources)', () => {
  const r = processExtraction(extraction({ items: [item({ quote: 'il cliente ha firmato il contratto' })] }), {
    template, session, newSegments: [seg(1, 'Ti invio il preventivo entro venerdì.')],
  });
  assert.equal(r.items.length, 0);
  assert.equal(r.rejected.length, 1);
});

test('wrong segment id is repaired only if the quote exists elsewhere', () => {
  const r = processExtraction(extraction({ items: [item({ source_segment_ids: ['S9'], quote: 'invio il preventivo' })] }), {
    template, session, newSegments: [seg(1, 'Buongiorno.'), seg(2, 'Ti invio il preventivo.')],
  });
  assert.deepEqual(r.items[0].source_segment_ids, ['S2']);
});

test('fields outside the template and "null" values are not stored', () => {
  const r = processExtraction(extraction({
    fields: [
      { key: 'colore_preferito', value: 'blu', certainty: 'certo', source_segment_ids: ['S1'], quote: 'blu' },
      { key: 'decisore', value: 'null', certainty: 'certo', source_segment_ids: ['S1'], quote: 'null' },
    ],
  }), { template, session, newSegments: [seg(1, 'Mi piace il blu.')] });
  assert.equal(r.fields.length, 0);
  assert.equal(r.rejected.length, 1);
});

test('TC04 a possibility stays a possibility', () => {
  const r = processExtraction(extraction({
    items: [item({ kind: 'need', content: 'avvio il mese prossimo', certainty: 'certo', quote: 'Potremmo partire il mese prossimo' })],
  }), { template, session, newSegments: [seg(1, 'Il progetto mi interessa. Potremmo partire il mese prossimo.', 'Cliente')] });
  assert.equal(r.items[0].status, 'ambiguo');
  assert.notEqual(r.items[0].certainty, 'certo');
});

test('FC02 self-correction is flagged for verification', () => {
  const r = processExtraction(extraction({
    fields: [{ key: 'prezzo', value: '50000 euro', certainty: 'certo', source_segment_ids: ['S1'], quote: 'anzi cinquantamila' }],
  }), { template, session, newSegments: [seg(1, 'Cinquemila euro, anzi cinquantamila.')] });
  assert.equal(r.fields.length, 1);
  assert.match(r.fields[0].status_reason, /autocorrezione/);
});

test('Carmine case: a statement linked to a guideline point fills it', () => {
  const r = processExtraction(extraction({
    items: [item({ kind: 'fact', content: 'la data di consegna è il 20 dicembre', field_key: 'data_consegna', value: '20 dicembre', quote: 'la data di consegna è il 20 dicembre' })],
  }), { template, session, newSegments: [seg(9, 'Eeeh, quindi la data di consegna è il 20 dicembre.')] });
  assert.equal(r.fields.length, 1);
  assert.equal(r.fields[0].key, 'data_consegna');
  assert.equal(r.fields[0].due_date, '2026-12-20');
});

test('Carmine case: safety net fills the point even if the model forgets to link it', () => {
  const r = processExtraction(extraction({
    items: [item({ kind: 'fact', content: 'la data di consegna è il 20 dicembre', quote: 'la data di consegna è il 20 dicembre' })],
  }), { template, session, newSegments: [seg(9, 'Eeeh, quindi la data di consegna è il 20 dicembre.'), seg(10, 'Il budget può rimanere 40.000 euro.')] });
  const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
  assert.equal(byKey.data_consegna.value, '20 dicembre');
  assert.match(byKey.data_consegna.status_reason, /collegato alla traccia dal sistema/);
  assert.match(byKey.budget.value, /40\.000 euro/);
  assert.equal(byKey.data_avvio, undefined, 'a delivery date is not a start date');
});

test('safety net never overrides a point that is already known', () => {
  const r = processExtraction(extraction(), {
    template, session, knownFields: { data_consegna: '10 dicembre (da_verificare)' },
    newSegments: [seg(1, 'Forse la consegna slitta al 20 dicembre.')],
  });
  assert.equal(r.fields.length, 0);
});

test('rules fallback extracts conservatively with sources', () => {
  const r = extractWithRules({ template, session, newSegments: [seg(1, 'Ti invio il preventivo entro venerdì. Il prezzo è di 15.000 euro.')] });
  assert.ok(r.items.some((i) => i.kind === 'commitment' && i.due_date === '2026-10-30'));
  assert.ok(r.fields.some((f) => f.key === 'prezzo'));
  assert.ok(r.items.every((i) => i.source_segment_ids[0] === 'S1' && i.confidence <= 0.3));
});
