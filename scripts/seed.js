// Fills the archive with the demo scenarios through the running server's API,
// so search / cross-session comparison have data. Usage: npm run seed
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USER = process.env.SEED_USER || 'luca';

const api = async (p, opts = {}) => {
  const res = await fetch(BASE + p, { ...opts, headers: { 'content-type': 'application/json', 'x-user-id': USER }, body: opts.body && JSON.stringify(opts.body) });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
};

const plan = [
  { scenario: 'preventivo-a', project: 'sito-rossi' },
  { scenario: 'preventivo-b', project: 'sito-rossi' },
  { scenario: 'riunione-progetto', project: 'app-mobile' },
];

try {
  await api('/api/health');
} catch {
  console.error(`Server non raggiungibile su ${BASE}: avvialo prima con "npm start".`);
  process.exit(1);
}

const scenarios = await api('/api/scenarios');
for (const step of plan) {
  const sc = scenarios.find((s) => s.id === step.scenario);
  const s = await api('/api/sessions', { method: 'POST', body: { title: sc.title, project: step.project, templateId: sc.template, consent: true, timezone: 'Europe/Rome' } });
  const { lines } = await api(`/api/sessions/${s.id}/simulate`, { method: 'POST', body: { scenario: sc.id, fast: true } });
  for (let i = 0; i < 60; i++) {
    const st = await api(`/api/sessions/${s.id}`);
    if (st.segments.length >= lines) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write(`• ${sc.title} (${step.project}) … `);
  const report = await api(`/api/sessions/${s.id}/complete`, { method: 'POST' });
  console.log(`ok: ${report.stats.items} elementi, ${report.cross_session.length} differenze con sessioni precedenti`);
}
console.log(`\nFatto. Apri ${BASE} (utente: ${USER}).`);
