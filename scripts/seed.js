// Loads the starter data (samples/demo.json: documents + past conversations)
// through the running server. Usage: npm run seed   (same as the UI button)
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USER = process.env.SEED_USER || 'luca';

const api = async (p, opts = {}) => {
  const res = await fetch(BASE + p, { ...opts, headers: { 'content-type': 'application/json', 'x-user-id': USER } });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
};

try {
  await api('/api/health');
} catch {
  console.error(`Server non raggiungibile su ${BASE}: avvialo prima con "npm start" o ".\\start.ps1".`);
  process.exit(1);
}

await api('/api/demo/seed', { method: 'POST' });
let shown = 0;
for (;;) {
  const job = await api('/api/demo/seed');
  for (; shown < job.log.length; shown++) console.log(`• ${job.log[shown]}`);
  if (!job.running) {
    if (job.error) { console.error(`Errore: ${job.error}`); process.exit(1); }
    const r = job.result;
    console.log(`\nFatto: ${r.documents} documenti, ${r.conversations} conversazioni caricate, ${r.skipped} già presenti. Apri ${BASE} (utente: ${USER}).`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
