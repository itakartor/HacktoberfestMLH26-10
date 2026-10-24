import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';

// One realtime Scribe connection per audio channel (mic / remote tab audio).
// Keeping channels separate gives reliable speaker attribution and makes it
// visible which side of the call is actually being captured (F01).
// The API key never leaves the server.

const MAX_RETRIES = 3;
const MAX_QUEUE_BYTES = 16000 * 2 * 10; // 10 s of PCM16 @16 kHz while (re)connecting

export class ElevenLabsChannel extends EventEmitter {
  constructor({ channel, apiKey = config.elevenLabsKey, language = config.sttLanguage, model = config.sttModel }) {
    super();
    this.channel = channel;
    this.apiKey = apiKey;
    this.language = language;
    this.model = model;
    this.ws = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.closedByUser = false;
    this.retries = 0;
    this.lostAt = null;
  }

  url() {
    const q = new URLSearchParams({
      model_id: this.model,
      audio_format: 'pcm_16000',
      language_code: this.language,
      commit_strategy: 'vad',
      vad_silence_threshold_secs: '0.9',
      min_silence_duration_ms: '400',
    });
    return `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q}`;
  }

  connect() {
    if (!this.apiKey) {
      queueMicrotask(() => this.emit('error', new Error('ELEVENLABS_API_KEY mancante: usare la modalità demo/simulazione')));
      return;
    }
    const ws = new WebSocket(this.url(), { headers: { 'xi-api-key': this.apiKey } });
    this.ws = ws;
    ws.on('message', (data) => this.#onMessage(data));
    ws.on('unexpected-response', (_req, res) => {
      this.emit('error', new Error(`ElevenLabs HTTP ${res.statusCode}`));
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', (code, reason) => {
      if (this.closedByUser) return this.emit('closed');
      if (this.retries >= MAX_RETRIES) return this.emit('error', new Error(`STT chiuso (${code} ${reason}) dopo ${MAX_RETRIES} tentativi`));
      if (!this.lostAt) {
        this.lostAt = Date.now();
        this.emit('lost', { code, reason: String(reason) });
      }
      this.retries++;
      setTimeout(() => this.connect(), 500 * 2 ** this.retries);
    });
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    switch (msg.message_type) {
      case 'session_started':
        this.retries = 0;
        if (this.lostAt) {
          this.emit('restored', { gap_ms: Date.now() - this.lostAt });
          this.lostAt = null;
        }
        this.emit('ready', msg);
        this.#flush();
        break;
      case 'partial_transcript':
        if (msg.text?.trim()) this.emit('partial', msg.text);
        break;
      case 'committed_transcript':
        if (msg.text?.trim()) this.emit('final', msg.text.trim());
        break;
      case 'warning':
        this.emit('warning', msg.warning);
        break;
      default:
        if (msg.error) this.emit('error', new Error(`${msg.message_type}: ${msg.error}`));
    }
  }

  #flush() {
    while (this.queue.length && this.ws?.readyState === WebSocket.OPEN) {
      const chunk = this.queue.shift();
      this.queuedBytes -= chunk.length;
      this.#send(chunk);
    }
  }

  #send(pcm) {
    this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm.toString('base64'), commit: false, sample_rate: 16000 }));
  }

  sendPcm(pcm) {
    if (this.ws?.readyState === WebSocket.OPEN && this.queue.length === 0) return this.#send(pcm);
    this.queue.push(pcm);
    this.queuedBytes += pcm.length;
    while (this.queuedBytes > MAX_QUEUE_BYTES) this.queuedBytes -= this.queue.shift().length;
  }

  close() {
    this.closedByUser = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Force-commit whatever is buffered so the last sentence is not lost.
        this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 }));
        setTimeout(() => this.ws?.close(), 1500);
      } else {
        this.ws?.terminate();
      }
    } catch { /* ignore */ }
  }
}
