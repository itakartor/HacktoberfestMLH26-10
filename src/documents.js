import path from 'node:path';
import { toVector } from './db.js';
import { HttpError } from './orchestrator.js';

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log']);
export const MAX_DOC_CHARS = 400_000;

/** Plain text out of an uploaded file. PDFs via unpdf (pure JS, no native deps). */
export async function extractText(buffer, filename = '') {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfText(pdf, { mergePages: true });
    return text;
  }
  if (TEXT_EXT.has(ext) || !ext) return buffer.toString('utf8');
  throw new HttpError(400, `formato non supportato: ${ext} (usa .txt, .md, .csv, .json o .pdf)`);
}

/**
 * Split on paragraph, then sentence boundaries into ~`size` char chunks with a
 * small overlap so a fact cut in half is still retrievable from one chunk.
 */
export function chunkText(text, { size = 900, overlap = 150 } = {}) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const pieces = clean.split(/\n\n+/).flatMap((p) => (p.length <= size ? [p] : p.split(/(?<=[.!?;])\s+/)));
  const chunks = [];
  let cur = '';
  for (const piece of pieces) {
    if (piece.length > size) { // pathological long sentence: hard split
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < piece.length; i += size - overlap) chunks.push(piece.slice(i, i + size));
      continue;
    }
    if (cur && cur.length + piece.length + 2 > size) {
      chunks.push(cur);
      cur = cur.slice(-overlap).replace(/^\S*\s/, ''); // carry a word-aligned tail
    }
    cur = cur ? `${cur}\n\n${piece}` : piece;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

export class DocumentStore {
  constructor({ db, llm }) {
    this.db = db;
    this.llm = llm;
  }

  async add(ownerId, { title, project = 'default', text, filename = null, mime = null }) {
    const body = String(text ?? '').trim();
    if (!body) throw new HttpError(400, 'documento vuoto: nessun testo estratto');
    if (body.length > MAX_DOC_CHARS) throw new HttpError(413, `documento troppo lungo (${body.length} caratteri, massimo ${MAX_DOC_CHARS})`);
    const { rows } = await this.db.query(
      `INSERT INTO documents (owner_id, project, title, filename, mime, chars) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ownerId, project || 'default', title?.trim() || filename || 'Documento senza titolo', filename, mime, body.length]);
    const doc = rows[0];
    const chunks = chunkText(body);
    for (const [i, c] of chunks.entries()) {
      await this.db.query('INSERT INTO document_chunks (id, document_id, seq, text) VALUES ($1,$2,$3,$4)',
        [`${doc.id.slice(0, 8)}-d${i + 1}`, doc.id, i + 1, c]);
    }
    const embedded = await this.embedPending(doc.id);
    return { ...doc, chunks: chunks.length, embedded };
  }

  /** Embeds chunks without a vector; returns how many were embedded (0 if Ollama is down). */
  async embedPending(documentId = null) {
    const { rows } = await this.db.query(
      `SELECT id, text FROM document_chunks WHERE embedding IS NULL AND ($1::uuid IS NULL OR document_id = $1) ORDER BY seq LIMIT 500`, [documentId]);
    let n = 0;
    try {
      for (let i = 0; i < rows.length; i += 16) {
        const batch = rows.slice(i, i + 16);
        const vectors = await this.llm.embed(batch.map((r) => r.text));
        for (const [j, v] of vectors.entries()) {
          await this.db.query('UPDATE document_chunks SET embedding = $2::vector WHERE id = $1', [batch[j].id, toVector(v)]);
          n++;
        }
      }
    } catch { /* text search still works; retried at next startup */ }
    return n;
  }

  async list(ownerId, project = null) {
    const { rows } = await this.db.query(
      `SELECT d.id, d.title, d.project, d.filename, d.chars, d.created_at,
              COUNT(c.id)::int AS chunks, COUNT(c.embedding)::int AS embedded
       FROM documents d LEFT JOIN document_chunks c ON c.document_id = d.id
       WHERE d.owner_id = $1 AND ($2::text IS NULL OR d.project = $2)
       GROUP BY d.id ORDER BY d.created_at DESC`, [ownerId, project]);
    return rows;
  }

  async get(ownerId, id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'documento non trovato');
    const { rows } = await this.db.query('SELECT * FROM documents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (!rows[0]) throw new HttpError(404, 'documento non trovato');
    const { rows: chunks } = await this.db.query('SELECT id, seq, text FROM document_chunks WHERE document_id = $1 ORDER BY seq', [id]);
    return { ...rows[0], chunks };
  }

  async delete(ownerId, id) {
    await this.get(ownerId, id);
    await this.db.query('DELETE FROM documents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  }
}
