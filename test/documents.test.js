import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, extractText, DocumentStore } from '../src/documents.js';
import { parseTranscript } from '../src/orchestrator.js';
import { setup, FakeLlm, extraction, item } from './helpers.js';

test('chunking keeps paragraphs together and covers all text', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Paragrafo ${i}. ${'parola '.repeat(30)}`).join('\n\n');
  const chunks = chunkText(text, { size: 500, overlap: 80 });
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.length <= 600));
  for (let i = 0; i < 12; i++) assert.ok(chunks.some((c) => c.includes(`Paragrafo ${i}.`)), `paragraph ${i} kept`);
  assert.deepEqual(chunkText('   '), []);
});

test('text files are read; unsupported formats are refused', async () => {
  assert.equal(await extractText(Buffer.from('ciao è'), 'nota.md'), 'ciao è');
  await assert.rejects(extractText(Buffer.from('x'), 'foto.png'), /non supportato/);
});

test('transcript parsing: speakers, timestamps, continuation lines', () => {
  const lines = parseTranscript('[10:02] Marco: Il budget è di 40.000 euro.\ne lo confermo.\n- Io: Ti invio il preventivo.\n\nRiga senza parlante iniziale');
  assert.deepEqual(lines.map((l) => l.speaker), ['Marco', 'Io']);
  assert.equal(lines[0].text, 'Il budget è di 40.000 euro. e lo confermo.');
  assert.match(lines[1].text, /Riga senza parlante/);
  assert.equal(parseTranscript('Testo libero senza nomi.')[0].speaker, 'Sconosciuto');
});

async function withDocs(llm) {
  const ctx = await setup(llm);
  ctx.docs = new DocumentStore({ db: ctx.db, llm: ctx.llm });
  ctx.orch.documents = ctx.docs;
  return ctx;
}

test('documents are searchable, labelled as documents and isolated per user', async () => {
  const { docs, orch } = await withDocs();
  const d = await docs.add('luca', { title: 'Listino 2026', project: 'sito', text: 'Sito con catalogo e area riservata: da 38.000 a 52.000 euro.' });
  assert.equal(d.chunks, 1);
  assert.equal(d.embedded, 0, 'no embeddings when the model is unavailable, text search still works');
  const hits = await orch.search('luca', 'quanto costa un catalogo con area riservata');
  assert.equal(hits[0].kind, 'documento');
  assert.equal(hits[0].document_title, 'Listino 2026');
  assert.equal((await orch.search('giulia', 'catalogo area riservata')).length, 0, 'other users never see it');
  assert.equal((await orch.search('luca', 'catalogo', { project: 'altro' })).length, 0, 'project filter applies');
  assert.equal((await orch.search('luca', 'catalogo', { includeDocuments: false })).length, 0);
  await assert.rejects(docs.delete('giulia', d.id), /non trovato/);
  await docs.delete('luca', d.id);
  assert.equal((await orch.search('luca', 'catalogo area')).length, 0, 'deleting removes chunks too');
});

test('Q&A cites documents and conversations with distinct labels', async () => {
  const llm = new FakeLlm(({ user }) => (user.includes('<evidenze>')
    ? (assert.match(user, /DOCUMENTO «Listino 2026»/), assert.match(user, /CONVERSAZIONE/),
      JSON.stringify({ answer: 'Il cliente ha detto 50.000 [E1], il listino indica 38-52k [E2].', sufficient_evidence: true, citations: ['E1', 'E2'], confidence: 'media', confidence_reason: 'due fonti', missing_information: [] }))
    : extraction()));
  const { docs, orch, session } = await withDocs(llm);
  const s = await session('luca', { project: 'sito' });
  await orch.onFinal(s.id, { channel: 'tab', speaker: 'Cliente', text: 'Per il catalogo con area riservata il prezzo è cinquantamila euro.' });
  await docs.add('luca', { title: 'Listino 2026', project: 'sito', text: 'Catalogo con area riservata: da 38.000 a 52.000 euro.' });
  const r = await orch.ask('luca', 'Prezzo del catalogo con area riservata?', { project: 'sito' });
  assert.equal(r.citations.length, 2);
  assert.deepEqual(new Set(r.evidence.map((e) => e.kind)), new Set(['conversazione', 'documento']));
});

test('imported transcript runs through the full pipeline and produces a report', async () => {
  const llm = new FakeLlm(({ user }) => {
    if (!user.includes('<trascrizione>') || user.includes('ELEMENTI ESTRATTI')) return JSON.stringify({ summary: 'ok', topics: [], open_points: [], needs_human_confirmation: [] });
    const m = user.match(/\[(S\d+) \| [^|]+ \| NUOVO\] (Ti invio[^\n]*)/);
    return extraction({ items: m ? [item({ source_segment_ids: [m[1]], quote: m[2], due: 'venerdì' })] : [] });
  });
  const { orch, db } = await withDocs(llm);
  const s = await orch.importTranscript('luca', {
    title: 'Call passata', project: 'sito', templateId: 'commerciale', consent: true, timezone: 'Europe/Rome', date: '2026-10-01T10:00:00Z',
    text: 'Marco: Il progetto ci interessa.\nIo: Ti invio il preventivo entro venerdì.',
  }, { wait: true });
  assert.equal(s.lines, 2);
  const st = await orch.getState('luca', s.id);
  assert.equal(st.session.status, 'completed');
  assert.equal(new Date(st.session.started_at).toISOString(), '2026-10-01T10:00:00.000Z', 'keeps the original date');
  const c = st.items.find((i) => i.kind === 'commitment');
  assert.equal(c.due_date, '2026-10-02', 'relative date resolved against the conversation date, not today');
  assert.equal(st.session.report.commitments.length, 1);
  await assert.rejects(orch.importTranscript('luca', { title: 'x', text: 'A: b', consent: false }), /autorizzata/);
  void db;
});
