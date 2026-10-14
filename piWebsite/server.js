#!/usr/bin/env node
/* ==========================================================================
   server.js — tiny, dependency-free server for "Rizal's Journey to Heroism".
   - Serves the website (index.html, style.css, script.js, data.js, images/).
   - GET  /api/health  -> { ok, ai, model }
   - POST /api/ask     -> { off, text, ids }   (the "Ask Pluma" assistant)

   The Gemini API key stays here, on the server, and the rules that keep the
   assistant on topic (Rizal only) and grounded (verified facts only) are
   applied HERE too, using the same data.js as the browser. A visitor cannot
   change the system prompt or the facts from the page.

   Run:   GEMINI_API_KEY=your-key node server.js
          (Windows PowerShell:  $env:GEMINI_API_KEY="your-key"; node server.js)
   Open:  http://localhost:3000
   Needs Node 18 or newer (uses the built-in fetch). No npm install required.
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const D = require('./data.js');

/* Optional: read GEMINI_API_KEY (and GEMINI_MODEL) from a file named .env next to this script.
   Lines look like  GEMINI_API_KEY=your-key  . Real environment variables win. .env is never served. */
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*["']?([^"'#\r\n]*?)["']?\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
} catch (err) { /* no .env file: fine */ }

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const CHAPTERS = new Set(['young-rizal', 'learner', 'traveler', 'writer', 'reformer', 'exile', 'final-journey', 'hero']);
const STATIC = new Set(['index.html', 'style.css', 'script.js', 'data.js', 'README.md']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/* Very small rate limit: 20 questions per minute per address. */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ask(req, res) {
  if (!API_KEY) return send(res, 503, { error: 'The AI is not configured on this server (missing GEMINI_API_KEY).' });
  if (limited(req.socket.remoteAddress || 'x')) return send(res, 429, { error: 'Too many questions. Please wait a minute.' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (err) { return send(res, 400, { error: 'Invalid request.' }); }
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 400) : '';
  if (!question) return send(res, 400, { error: 'Please type a question.' });
  const chapter = CHAPTERS.has(body.chapter) ? body.chapter : null;
  const history = Array.isArray(body.history)
    ? body.history.filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')).slice(-6)
    : [];

  const facts = D.factsForPrompt(question, chapter);           // retrieval happens on the server
  const payload = D.buildGeminiRequest(question, history, facts);   // system prompt is applied here, not by the page
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const upstream = await fetch(`${API_BASE}/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(payload),
    });
    if (!upstream.ok) {
      console.error('Gemini error', upstream.status, (await upstream.text()).slice(0, 300));
      const msg = upstream.status === 429 ? 'The AI quota was reached. Please try again in a minute.'
        : (upstream.status === 400 || upstream.status === 403) ? 'The AI service rejected the request (check the API key and model name).'
        : `The AI service returned an error (${upstream.status}).`;
      return send(res, 502, { error: msg });
    }
    const reply = D.geminiText(await upstream.json());
    if (!reply.text) return send(res, 502, { error: `The AI returned no answer (${reply.reason}).` });
    return send(res, 200, D.parseAnswer(reply.text, new Set(facts.map((f) => f.id))));
  } catch (err) {
    console.error('Ask failed:', err.message);
    return send(res, 502, { error: 'The AI service could not be reached.' });
  } finally { clearTimeout(timer); }
}

function serveStatic(req, res) {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (err) { return send(res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
  /* Normalize FIRST, so "/images/../server.js" becomes "/server.js" and is rejected. */
  const rel = path.posix.normalize('/' + url).replace(/^\/+/, '') || 'index.html';
  const imagesDir = path.join(__dirname, 'images') + path.sep;
  const file = path.join(__dirname, rel);
  const allowed = STATIC.has(rel) || (rel.startsWith('images/') && file.startsWith(imagesDir));
  if (!allowed) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const route = (req.url || '').split('?')[0];
  if (route === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, ai: !!API_KEY, model: MODEL });
  if (route === '/api/ask' && req.method === 'POST') return ask(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return send(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  console.log(`Rizal's Journey to Heroism is running at http://localhost:${PORT}`);
  console.log(API_KEY ? `AI helper: ON (model ${MODEL})` : 'AI helper: OFF. Set GEMINI_API_KEY to enable it. The fact finder still works.');
});