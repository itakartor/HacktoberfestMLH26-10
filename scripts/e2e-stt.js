// End-to-end check of the REAL audio path: WAV (16 kHz mono PCM16) →
// WebSocket like the browser → server → ElevenLabs realtime → Gemma.
// Usage: node scripts/e2e-stt.js [file.wav]   (server must be running)
// Without a file, on Windows it synthesizes Italian speech with SAPI.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { ROOT } from '../src/config.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USER = 'luca';
const TEXT = 'Buongiorno, sono Marco. Il budget per il progetto è di trentamila euro. Ti invio il contratto firmato entro giovedì. La consegna deve essere entro il 15 dicembre.';

function synthesize(out) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'it-IT' } | Select-Object -First 1;
    if ($v) { $s.SelectVoice($v.VoiceInfo.Name) };
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);
    $s.Rate = 0; $s.SetOutputToWaveFile('${out}', $fmt); $s.Speak('${TEXT}'); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps]);
}

function pcmFromWav(buf) {
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const rate = buf.readUInt32LE(off + 12);
      const channels = buf.readUInt16LE(off + 10);
      if (rate !== 16000 || channels !== 1) throw new Error(`serve WAV 16 kHz mono, trovato ${rate} Hz ${channels} ch`);
    }
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size;
  }
  throw new Error('chunk data non trovato');
}

const api = async (p, opts = {}) => {
  const res = await fetch(BASE + p, { ...opts, headers: { 'content-type': 'application/json', 'x-user-id': USER }, body: opts.body && JSON.stringify(opts.body) });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
};

let file = process.argv[2];
if (!file) {
  mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  file = path.join(ROOT, 'data', 'e2e-it.wav');
  if (!existsSync(file)) { console.log('Sintesi audio italiano con Windows SAPI…'); synthesize(file); }
}
const pcm = pcmFromWav(readFileSync(file));
console.log(`Audio: ${(pcm.length / 32000).toFixed(1)} s`);

const session = await api('/api/sessions', { method: 'POST', body: { title: 'E2E STT reale', templateId: 'commerciale', consent: true, timezone: 'Europe/Rome', project: 'e2e' } });
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?session=${session.id}&user=${USER}`);
const finals = [];
let partials = 0;
const t0 = Date.now();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.kind === 'stt') console.log(`[stt ${msg.channel}] ${msg.state} ${msg.message ?? ''}`);
  if (msg.kind !== 'event') return;
  const e = msg.event;
  if (e.type === 'transcript_partial') partials++;
  if (e.type === 'transcript_final') { finals.push(e.payload.text); console.log(`[final +${Date.now() - t0}ms] ${e.payload.text}`); }
  if (e.type === 'information_extracted') console.log(`  [estratto] ${e.payload.item.content} (${e.payload.item.status})`);
});
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'start_audio', channels: ['mic'] }));
await new Promise((r) => setTimeout(r, 1500));

// Stream in real time, 100 ms chunks, prefixed with channel byte 0 (mic).
for (let i = 0; i < pcm.length; i += 3200) {
  ws.send(Buffer.concat([Buffer.from([0]), pcm.subarray(i, i + 3200)]));
  await new Promise((r) => setTimeout(r, 100));
}
const silence = Buffer.alloc(3200);
for (let i = 0; i < 20; i++) { ws.send(Buffer.concat([Buffer.from([0]), silence])); await new Promise((r) => setTimeout(r, 100)); }
ws.send(JSON.stringify({ type: 'stop_audio' }));
await new Promise((r) => setTimeout(r, 4000));

const report = await api(`/api/sessions/${session.id}/complete`, { method: 'POST' });
ws.close(1000);
console.log(`\nParziali: ${partials} · Segmenti definitivi: ${finals.length}`);
console.log('Campi:', report.fields.map((f) => `${f.key}=${f.value ?? '—'} [${f.status}]`).join(' · '));
console.log('Impegni:', report.commitments.map((c) => `${c.content} (${c.due_text ?? ''} ${c.due_date ?? ''})`).join(' | ') || '—');
console.log(`Sessione: ${BASE}/  (id ${session.id})`);
if (!finals.length) { console.error('NESSUNA trascrizione ricevuta'); process.exit(1); }
