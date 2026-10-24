import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile) && !process.env.NO_ENV_FILE) process.loadEnvFile(envFile);

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  elevenLabsKey: env.ELEVENLABS_API_KEY || '',
  sttLanguage: env.STT_LANGUAGE || 'it',
  sttModel: env.STT_MODEL || 'scribe_v2_realtime',
  databaseUrl: env.DATABASE_URL || '',
  dataDir: env.DATA_DIR || path.join(ROOT, 'data', 'pgdata'),
  ollamaUrl: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  embedModel: env.EMBED_MODEL || 'embeddinggemma',
  llmModel: env.LLM_MODEL || 'gemma4:e4b-it-qat',
  llmTimeoutMs: Number(env.LLM_TIMEOUT_MS || 60000),
  embedDim: 768,
  // Live layer tuning (README §4): never call Gemma on every word.
  extractionDebounceMs: Number(env.EXTRACTION_DEBOUNCE_MS || 2500),
  extractionMaxBatch: Number(env.EXTRACTION_MAX_BATCH || 3),
  contextWindowSegments: Number(env.CONTEXT_WINDOW_SEGMENTS || 10),
  maxSuggestionsPerMinute: Number(env.MAX_SUGGESTIONS_PER_MINUTE || 3),
  fieldQuestionCooldownMs: Number(env.FIELD_QUESTION_COOLDOWN_MS || 90000),
  minSegmentsBeforeMissingQuestions: Number(env.MIN_SEGMENTS_BEFORE_QUESTIONS || 3),
  searchMinSimilarity: Number(env.SEARCH_MIN_SIMILARITY || 0.35),
};

export const SCHEMA_VERSION = '1.0';
