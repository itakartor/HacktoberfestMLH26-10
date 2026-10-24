import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const SAMPLES = path.join(ROOT, 'samples');

export function loadScenarios() {
  const dir = path.join(SAMPLES, 'scenarios');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
}

/**
 * Loads samples/demo.json: reference documents + past conversations, in
 * chronological order, through the normal pipeline. Skips what already exists
 * (same title + project), so it can be run more than once.
 */
export async function seedDemo({ orch, documents, ownerId, log = () => {} }) {
  const manifest = JSON.parse(readFileSync(path.join(SAMPLES, 'demo.json'), 'utf8'));
  const scenarios = loadScenarios();
  const done = { documents: 0, conversations: 0, skipped: 0 };

  const existingDocs = await documents.list(ownerId);
  for (const d of manifest.documents) {
    if (existingDocs.some((x) => x.title === d.title && x.project === d.project)) { done.skipped++; continue; }
    await documents.add(ownerId, { title: d.title, project: d.project, filename: path.basename(d.file), text: readFileSync(path.join(SAMPLES, d.file), 'utf8') });
    done.documents++;
    log(`documento: ${d.title}`);
  }

  const existingSessions = await orch.listSessions(ownerId);
  const convs = [...manifest.conversations].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const c of convs) {
    let title = c.title;
    let template = c.template;
    let text;
    if (c.scenario) {
      const sc = scenarios.find((s) => s.id === c.scenario);
      title ??= sc.title;
      template ??= sc.template;
      text = sc.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
    } else {
      text = readFileSync(path.join(SAMPLES, c.transcript), 'utf8');
    }
    if (existingSessions.some((s) => s.title === title && s.project === c.project)) { done.skipped++; continue; }
    log(`conversazione: ${title} (in elaborazione con Gemma…)`);
    await orch.importTranscript(ownerId, { title, project: c.project, templateId: template, text, date: c.date, timezone: 'Europe/Rome', consent: true }, { wait: true });
    done.conversations++;
  }
  return done;
}
