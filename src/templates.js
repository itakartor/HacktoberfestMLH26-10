import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROOT } from './config.js';

// Templates are data, not code (README §6): adding one means dropping a JSON
// file in /templates or POSTing it to /api/templates.

export const MODES = ['sintetica', 'esplorativa', 'verifica', 'decisionale', 'monitoraggio', 'critica'];

const FieldSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string(),
  description: z.string().default(''),
  required: z.boolean().default(false),
  critical: z.boolean().default(false),
  question: z.string().optional(),
});

const RuleSchema = z.object({
  id: z.string(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  when: z.object({
    field: z.string().optional(),
    status_in: z.array(z.string()).optional(),
    kind: z.string().optional(),
    certainty_in: z.array(z.string()).optional(),
    text_matches: z.string().optional(),
    after_segments: z.number().int().nonnegative().default(0),
  }),
  then: z.object({
    type: z.enum(['alert', 'question']),
    message: z.string(),
  }),
});

export const TemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  version: z.number().int().positive(),
  description: z.string().default(''),
  context: z.string().default(''),
  goal: z.string().default(''),
  mode: z.enum(MODES),
  look_for: z.array(z.string()).default([]),
  fields: z.array(FieldSchema).default([]),
  rules: z.array(RuleSchema).default([]),
  feedback: z.object({
    live_questions: z.boolean().default(true),
    max_live_suggestions_per_minute: z.number().int().positive().default(3),
  }).default({ live_questions: true, max_live_suggestions_per_minute: 3 }),
  escalation: z.object({
    require_human_confirmation_for: z.array(z.string()).default([]),
  }).default({ require_human_confirmation_for: [] }),
  tests: z.array(z.object({ input: z.string(), expect: z.record(z.string(), z.any()) })).default([]),
});

const DIR = path.join(ROOT, 'templates');

export class TemplateStore {
  constructor(dir = DIR) {
    this.dir = dir;
    this.archive = path.join(dir, 'archive');
    this.templates = new Map(); // id -> latest
    this.reload();
  }

  reload() {
    this.templates.clear();
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      const t = TemplateSchema.parse(JSON.parse(readFileSync(path.join(this.dir, f), 'utf8')));
      this.templates.set(t.id, t);
    }
  }

  list() {
    return [...this.templates.values()];
  }

  get(id, version) {
    const latest = this.templates.get(id);
    if (!latest) return null;
    if (!version || version === latest.version) return latest;
    const archived = path.join(this.archive, `${id}.v${version}.json`);
    return existsSync(archived) ? TemplateSchema.parse(JSON.parse(readFileSync(archived, 'utf8'))) : latest;
  }

  // Saving an existing id archives the previous version and bumps the version.
  save(input) {
    const prev = this.templates.get(input.id);
    const t = TemplateSchema.parse({ ...input, version: prev ? prev.version + 1 : 1 });
    if (prev) {
      mkdirSync(this.archive, { recursive: true });
      writeFileSync(path.join(this.archive, `${prev.id}.v${prev.version}.json`), JSON.stringify(prev, null, 2));
    }
    writeFileSync(path.join(this.dir, `${t.id}.json`), JSON.stringify(t, null, 2));
    this.templates.set(t.id, t);
    return t;
  }
}

