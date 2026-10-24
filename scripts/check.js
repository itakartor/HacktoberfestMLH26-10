// Prerequisite check: npm run check
import { config } from '../src/config.js';
import { OllamaClient } from '../src/llm/ollama.js';

const ok = (b) => (b ? '✔' : '✖');
const major = Number(process.versions.node.split('.')[0]);
console.log(`${ok(major >= 22)} Node.js ${process.versions.node} (serve >= 22)`);
console.log(`${ok(config.elevenLabsKey)} ELEVENLABS_API_KEY ${config.elevenLabsKey ? 'presente' : 'mancante → solo scenari demo, niente microfono'}`);
const st = await new OllamaClient().status();
console.log(`${ok(st.reachable)} Ollama su ${config.ollamaUrl} ${st.reachable ? '' : '→ avvia l\'app Ollama o "ollama serve"'}`);
console.log(`${ok(st.llm)} Modello ${config.llmModel} ${st.llm ? '' : `→ ollama pull ${config.llmModel}`}`);
console.log(`${ok(st.embed)} Embedding ${config.embedModel} ${st.embed ? '' : `→ ollama pull ${config.embedModel}`}`);
console.log(`  Database: ${config.databaseUrl ? 'PostgreSQL esterno (DATABASE_URL)' : `PGlite embedded in ${config.dataDir}`}`);
