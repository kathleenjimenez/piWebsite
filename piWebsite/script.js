/* ==========================================================================
   Rizal’s Journey to Heroism — script.js
   Plain JavaScript, no libraries. Sections:
     1. Utilities
     2. Voice reader (Web Speech API) with synchronized highlighting
     3. Chapter router, progress bar, chapter menu, pagers
     4. “Why?” and “How?” explanation dialog
     5. Image viewer (lightbox)
     6. Timeline, tabs, saved reflection notes
     7. Start-up
   ========================================================================== */
(() => {
  'use strict';
 
  /* ------------------------------------------------------------------------
     1. UTILITIES
     ------------------------------------------------------------------------ */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const icon = (id) => `<svg class="ico" aria-hidden="true" focusable="false"><use href="#${id}"></use></svg>`;
 
  /* localStorage can be blocked (private mode, strict settings), so wrap it. */
  const storage = {
    get(key, fallback = '') {
      try { const v = window.localStorage.getItem(key); return v === null ? fallback : v; }
      catch (err) { return fallback; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch (err) { /* storage unavailable: ignore */ }
    },
  };
 
  /* ------------------------------------------------------------------------
     2. VOICE READER
     How it works
     - The visible text of the chosen area is split into “blocks” (paragraphs,
       headings, list items, definition terms and descriptions).
     - Each block is split into sentence-sized “chunks”. One utterance is
       spoken per chunk. This avoids the browser bug where long utterances
       stop after about 15 seconds, and it gives us a reliable sentence-level
       highlight even when the voice reports no word timing.
     - If the voice fires `boundary` events, the current word is highlighted
       too (word-level). Otherwise only the sentence is highlighted.
     - Pause stops speaking but remembers the position. Resume restarts the
       current sentence. This behaves the same in every browser, unlike the
       native pause()/resume(), which is unreliable on some platforms.
     ------------------------------------------------------------------------ */
 
  /* Which elements count as readable text, and which are never read. */
  const READABLE = 'h1, h2, h3, h4, p, li, dt, dd, blockquote, figcaption, summary';
  const NEVER_READ = '.no-read, button, nav, template, script, style, select, textarea, .ph, .tablist, .chapter-sources, [hidden], [aria-hidden="true"]';
 
  /* Collect the visible, readable blocks inside `root`. */
  function collectBlocks(root) {
    return $$(READABLE, root).filter((el) => {
      if (el.closest(NEVER_READ)) return false;                 // excluded areas
      if (el.querySelector(READABLE)) return false;             // read leaf blocks only
      if (!el.getClientRects().length) return false;            // not visible right now
      const langHost = el.closest('[lang]');                    // skip non-English quotations
      if (langHost && !/^en/i.test(langHost.lang)) return false;
      return el.textContent.trim().length > 1;
    });
  }
 
  /* Map every text node of a block to its position inside the block’s text. */
  function buildTextMap(block) {
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        return parent && parent.closest('.no-read, button, script, style')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: text.length });
      text += node.nodeValue;
    }
    return { text, nodes };
  }
 
  /* Split block text into sentence-sized chunks.
     Each chunk keeps its start/end in the raw text, a whitespace-collapsed
     `spoken` string, and `map` (spoken index → raw index) so boundary events
     can be translated back to the right word on the page. */
  const ABBREVIATION = /\b(?:Dr|Fr|Mr|Mrs|Ms|Sr|Jr|St|Gov|Gen|Lt|Col|No|vs)\.\s*$|\b[A-Z]\.\s*$/;
  const MAX_CHUNK = 230;
 
  function makeChunks(text) {
    const ranges = [];
    const sentence = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g;
    let match;
    while ((match = sentence.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      const previous = ranges[ranges.length - 1];
      if (previous && ABBREVIATION.test(text.slice(previous.start, previous.end))) {
        previous.end = end;                       // “Dr.” or “H.” does not end a sentence
      } else {
        ranges.push({ start, end });
      }
    }
    if (!ranges.length && text.trim()) ranges.push({ start: 0, end: text.length });
 
    /* Break very long sentences at a comma or space so each utterance stays short. */
    const pieces = [];
    ranges.forEach((range) => {
      let { start } = range;
      while (range.end - start > MAX_CHUNK) {
        const window = text.slice(start, start + MAX_CHUNK);
        let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
        if (cut < MAX_CHUNK * 0.4) cut = window.lastIndexOf(' ');
        if (cut <= 0) cut = MAX_CHUNK;
        pieces.push({ start, end: start + cut + 1 });
        start += cut + 1;
      }
      pieces.push({ start, end: range.end });
    });
 
    return pieces.map(({ start, end }) => {
      const raw = text.slice(start, end);
      let spoken = '';
      const map = [];
      let lastWasSpace = true;                    // trims leading whitespace
      for (let i = 0; i < raw.length; i++) {
        const isSpace = /\s/.test(raw[i]);
        if (isSpace && lastWasSpace) continue;
        spoken += isSpace ? ' ' : raw[i];
        map.push(start + i);
        lastWasSpace = isSpace;
      }
      return { start, end, spoken: spoken.trim(), map };
    }).filter((chunk) => chunk.spoken.length > 0);
  }
 
  /* ---- Highlighter: wraps words of ONE block in spans, then restores it ---- */
  const Highlighter = (() => {
    let block = null;
    let spans = [];
    let sentenceSpans = [];
    let wordSpans = [];
    let lastScroll = 0;
 
    /* Wrap each word of the block in <span class="rw"> without touching links,
       emphasis or buttons. Spans store their character offsets. */
    function prepare(el, nodes) {
      clear();
      block = el;
      nodes.forEach(({ node, start }) => {
        const value = node.nodeValue;
        if (!/\S/.test(value) || !node.parentNode) return;
        const fragment = document.createDocumentFragment();
        const word = /\S+/g;
        let last = 0;
        let m;
        while ((m = word.exec(value))) {
          if (m.index > last) fragment.append(value.slice(last, m.index));
          const span = document.createElement('span');
          span.className = 'rw';
          span.textContent = m[0];
          span._s = start + m.index;
          span._e = span._s + m[0].length;
          fragment.append(span);
          spans.push(span);
          last = m.index + m[0].length;
        }
        if (last < value.length) fragment.append(value.slice(last));
        node.replaceWith(fragment);
      });
      block.classList.add('is-reading');
    }
 
    function sentence(start, end) {
      sentenceSpans.forEach((s) => s.classList.remove('rw-sentence'));
      clearWord();
      sentenceSpans = spans.filter((s) => s._e > start && s._s < end);
      sentenceSpans.forEach((s) => s.classList.add('rw-sentence'));
      return sentenceSpans[0] || null;
    }
 
    function clearWord() {
      wordSpans.forEach((s) => s.classList.remove('rw-now'));
      wordSpans = [];
    }
 
    /* Highlight the word at raw offset `index` (and `length` characters if the
       engine reports them). Returns the first highlighted span. */
    function word(index, length) {
      clearWord();
      const span = length > 0 && length < 40
        ? spans.filter((s) => s._e > index && s._s < index + length)
        : spans.filter((s) => s._s <= index && index < s._e);
      if (!span.length) {
        const next = spans.find((s) => s._s >= index);
        if (next) span.push(next);
      }
      wordSpans = span;
      wordSpans.forEach((s) => s.classList.add('rw-now'));
      return wordSpans[0] || null;
    }
 
    /* Undo everything: unwrap the spans so the original text nodes return. */
    function clear() {
      if (!block) return;
      spans.forEach((s) => {
        if (s.parentNode) s.replaceWith(document.createTextNode(s.textContent));
      });
      block.normalize();
      block.classList.remove('is-reading');
      block = null; spans = []; sentenceSpans = []; wordSpans = [];
    }
 
    /* Scroll only when the active text leaves a comfortable band, and not
       more than once every 600 ms, so the page does not jitter. */
    function ensureVisible(el) {
      if (!el) return;
      const now = Date.now();
      if (now - lastScroll < 600) return;
      const rect = el.getBoundingClientRect();
      const top = 100;
      const bottom = window.innerHeight - 190;    // leave room for the reader panel
      if (rect.top < top || rect.bottom > bottom) {
        lastScroll = now;
        el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    }
 
    return { prepare, sentence, word, clear, ensureVisible, get block() { return block; } };
  })();
 
  /* ---- Reader: queue, speech and state ---- */
  const Reader = (() => {
    const supported = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';
    const synth = supported ? window.speechSynthesis : null;
 
    let state = 'stopped';          // 'stopped' | 'playing' | 'paused'
    let scope = null;               // 'page' | 'paragraph' | 'insight' | 'home'
    let label = '';
    let queue = [];                 // blocks to read
    let blockIndex = 0;
    let chunkIndex = 0;
    let item = null;                // prepared data for queue[blockIndex]
    let token = 0;                  // changes whenever a session or utterance is replaced
    let timer = 0;
    let utterance = null;           // keep a reference: some browsers drop unreferenced utterances
    let boundarySeen = false;
    let note = '';
 
    let rate = parseFloat(storage.get('rizal.rate', '1')) || 1;
    let voiceURI = storage.get('rizal.voice', '');
    let voices = [];
 
    const listeners = new Set();
    const snapshot = () => ({
      supported, state, scope, label, note,
      index: blockIndex, total: queue.length,
      mode: boundarySeen ? 'word' : 'sentence',
      started: blockIndex > 0 || chunkIndex > 0,
      rate, voiceURI, voices,
    });
    const emit = () => { const s = snapshot(); listeners.forEach((fn) => fn(s)); };
    const setNote = (text) => { note = text; emit(); };
 
    /* ---- Voices ---- */
    function loadVoices() {
      if (!supported) return;
      const all = synth.getVoices() || [];
      const english = all.filter((v) => /^en/i.test(v.lang));
      voices = english.length ? english : all;
      emit();
    }
 
    function pickVoice() {
      if (!voices.length) return null;
      const saved = voices.find((v) => v.voiceURI === voiceURI);
      if (saved) return saved;
      for (const lang of ['en-ph', 'en-us', 'en-gb', 'en-au', 'en']) {
        const found = voices.find((v) => (v.lang || '').replace('_', '-').toLowerCase().startsWith(lang));
        if (found) return found;
      }
      return voices[0];
    }
 
    /* ---- Speaking ---- */
    function speakCurrent() {
      if (state !== 'playing') return;
      const block = queue[blockIndex];
      if (!block || !block.isConnected) { advanceBlock(); return; }
 
      /* First time we reach this block: map its text, split it, wrap its words. */
      if (!item || item.block !== block) {
        const map = buildTextMap(block);
        item = { block, text: map.text, nodes: map.nodes, chunks: makeChunks(map.text) };
        if (!item.chunks.length) { advanceBlock(); return; }
        Highlighter.prepare(block, map.nodes);
        Highlighter.ensureVisible(block);
        emit();
      }
 
      const chunk = item.chunks[chunkIndex];
      const mine = ++token;                      // events from older utterances are ignored
 
      /* Show the sentence immediately, so a resume restores the highlight at once. */
      Highlighter.ensureVisible(Highlighter.sentence(chunk.start, chunk.end));
 
      const u = new window.SpeechSynthesisUtterance(chunk.spoken);
      const voice = pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
      u.rate = rate;
      u.pitch = 1;
 
      u.onboundary = (event) => {
        if (mine !== token) return;
        if (event.name && event.name !== 'word') return;
        if (!boundarySeen) { boundarySeen = true; emit(); }
        const spokenIndex = clamp(event.charIndex || 0, 0, chunk.map.length - 1);
        const span = Highlighter.word(chunk.map[spokenIndex], event.charLength || 0);
        Highlighter.ensureVisible(span);
      };
      u.onend = () => { if (mine === token) nextChunk(); };
      u.onerror = (event) => {
        if (mine !== token) return;
        if (event.error === 'canceled' || event.error === 'interrupted') return;
        fail(event.error);
      };
 
      utterance = u;
      try {
        if (synth.paused) synth.resume();        // clear any stuck native pause
        synth.speak(u);
      } catch (err) {
        fail(err && err.message ? err.message : 'unknown error');
      }
    }
 
    function nextChunk() {
      chunkIndex += 1;
      if (item && chunkIndex < item.chunks.length) { speakCurrent(); return; }
      advanceBlock();
    }
 
    function advanceBlock() {
      Highlighter.clear();
      item = null;
      chunkIndex = 0;
      blockIndex += 1;
      if (blockIndex >= queue.length) { finish(); return; }
      emit();
      speakCurrent();
    }
 
    function finish() {
      reset();
      setNote('Finished reading.');
    }
 
    function fail(reason) {
      reset();
      if (reason === 'not-allowed') {
        setNote('The browser blocked audio. Press Read aloud again after interacting with the page.');
      } else {
        setNote(`Speech stopped (${reason}). Try another voice from the list, or reload the page.`);
      }
    }
 
    /* Cancel speech, remove highlighting, forget the queue. */
    function reset() {
      token += 1;
      clearTimeout(timer);
      if (supported) { try { synth.cancel(); } catch (err) { /* ignore */ } }
      Highlighter.clear();
      queue = []; blockIndex = 0; chunkIndex = 0; item = null;
      state = 'stopped'; scope = null; label = ''; boundarySeen = false;
      emit();
    }
 
    /* After cancel(), some browsers need a short pause before speak() works. */
    function restartSoon(delay = 80) {
      token += 1;
      clearTimeout(timer);
      try { synth.cancel(); } catch (err) { /* ignore */ }
      timer = setTimeout(speakCurrent, delay);
    }
 
    /* ---- Public controls ---- */
    function start(blocks, options = {}) {
      if (!supported) {
        setNote('Your browser does not support the Web Speech API, so the voice reader is unavailable. All the text on the page is still available to read.');
        return false;
      }
      if (!blocks.length) { setNote('There is nothing readable to play here.'); return false; }
      reset();
      queue = blocks;
      scope = options.scope || 'page';
      label = options.label || '';
      state = 'playing';
      note = '';
      emit();
      restartSoon(80);
      return true;
    }
 
    function pause() {
      if (state !== 'playing') return;
      state = 'paused';
      token += 1;                                 // ignore the cancel event
      clearTimeout(timer);
      try { synth.cancel(); } catch (err) { /* ignore */ }
      emit();
    }
 
    function resume() {
      if (state !== 'paused') return;
      state = 'playing';
      emit();
      restartSoon(60);                            // restarts the current sentence
    }
 
    function stop() {
      if (state === 'stopped' && !queue.length) return;
      reset();
    }
 
    function setRate(value) {
      rate = clamp(parseFloat(value) || 1, 0.5, 2);
      storage.set('rizal.rate', String(rate));
      if (state === 'playing') restartSoon(80);
      emit();
    }
 
    function setVoice(uri) {
      voiceURI = uri || '';
      storage.set('rizal.voice', voiceURI);
      if (state === 'playing') restartSoon(80);
      emit();
    }
 
    function init() {
      if (!supported) return;
      loadVoices();
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', loadVoices);
      else synth.onvoiceschanged = loadVoices;
      /* Never leave speech running after the visitor reloads or leaves. */
      window.addEventListener('pagehide', () => { try { synth.cancel(); } catch (err) { /* ignore */ } });
    }
 
    return {
      supported, init, start, pause, resume, stop, setRate, setVoice,
      subscribe(fn) { listeners.add(fn); fn(snapshot()); },
      get state() { return state; },
      get scope() { return scope; },
      get currentBlock() { return queue[blockIndex] || null; },
    };
  })();
 
  /* ---- Reader user interface (panel + dialog controls) ---- */
  const ReaderUI = (() => {
    const panel = $('#reader');
    const toggle = $('#reader-toggle');
    const body = $('#reader-body');
    const statusEl = $('#reader-status');
    const nowEl = $('#reader-now');
    const noteEl = $('#reader-note');
    const playBtn = $('#rd-play');
    const pauseBtn = $('#rd-pause');
    const resumeBtn = $('#rd-resume');
    const stopBtn = $('#rd-stop');
    const rateSelects = $$('[data-rate-control]');
    const voiceSelects = $$('[data-voice-control]');
    const insightListen = $('#insight-listen');
    const insightPause = $('#insight-pause');
    const insightStatus = $('#insight-status');
 
    const STATUS = { stopped: 'Stopped', playing: 'Playing', paused: 'Paused' };
 
    function setOpen(open) {
      if (!panel || !toggle || !body) return;
      panel.dataset.open = String(open);
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
    }
 
    /* Rebuild the voice lists only when the set of voices changes. */
    let renderedVoices = '';
    function renderVoices(s) {
      const signature = s.voices.map((v) => v.voiceURI).join('|');
      if (signature === renderedVoices) return;
      renderedVoices = signature;
      voiceSelects.forEach((select) => {
        select.innerHTML = '';
        const auto = new Option('Browser default', '');
        select.add(auto);
        s.voices.forEach((v) => select.add(new Option(`${v.name} (${v.lang})`, v.voiceURI)));
      });
    }
 
    function render(s) {
      panel.dataset.state = s.state;
      statusEl.textContent = STATUS[s.state];
 
      playBtn.disabled = !s.supported || s.state === 'playing';
      pauseBtn.disabled = s.state !== 'playing';
      resumeBtn.disabled = s.state !== 'paused';
      stopBtn.disabled = s.state === 'stopped';
 
      renderVoices(s);
      rateSelects.forEach((el) => { el.value = String(s.rate); if (el.value !== String(s.rate)) el.value = '1'; });
      voiceSelects.forEach((el) => { el.value = s.voiceURI; });
 
      /* Reading position and highlighting mode */
      if (!s.supported) {
        nowEl.textContent = '';
      } else if (s.state === 'stopped') {
        nowEl.textContent = 'Choose “Read this chapter” on a page, or press Read aloud to hear the page you are on.';
      } else {
        const mode = s.mode === 'word'
          ? 'Highlighting word by word.'
          : s.started
            ? 'Highlighting sentence by sentence (this voice does not report word timing).'
            : 'Highlighting by sentence; word-by-word starts if your voice supports it.';
        nowEl.textContent = `${STATUS[s.state]}: ${s.label || 'text'}, part ${Math.min(s.index + 1, s.total)} of ${s.total}. ${mode}`;
      }
      noteEl.textContent = s.supported ? s.note : 'Voice reading is not supported by this browser. Everything on the page can still be read as text.';
 
      /* The explanation dialog has its own two buttons. */
      const inInsight = s.scope === 'insight' && s.state !== 'stopped';
      insightListen.querySelector('span').textContent = inInsight ? 'Stop' : 'Listen';
      insightPause.disabled = !inInsight;
      insightPause.querySelector('span').textContent = s.state === 'paused' ? 'Resume' : 'Pause';
      insightStatus.textContent = inInsight
        ? (s.state === 'paused' ? 'Paused.' : (s.mode === 'word' ? 'Reading, word by word.' : 'Reading.'))
        : (s.supported ? s.note : 'Voice reading is not supported by this browser.');
 
      document.querySelectorAll('[data-read]').forEach((btn) => { btn.disabled = !s.supported; btn.title = s.supported ? '' : 'Voice reading is not supported by this browser'; });
    }
 
    function init() {
      /* Guard optional controls so one missing element cannot disable the site. */
      if (toggle && body) toggle.addEventListener('click', () => setOpen(body.hidden));
      if (playBtn) playBtn.addEventListener('click', () => readPage(true));
      if (pauseBtn) pauseBtn.addEventListener('click', () => Reader.pause());
      if (resumeBtn) resumeBtn.addEventListener('click', () => Reader.resume());
      if (stopBtn) stopBtn.addEventListener('click', () => Reader.stop());
      rateSelects.forEach((el) => el.addEventListener('change', () => Reader.setRate(el.value)));
      voiceSelects.forEach((el) => el.addEventListener('change', () => Reader.setVoice(el.value)));
 
      /*
       * These delegated handlers are important: the chapter/home buttons and
       * paragraph speaker buttons were being displayed, but had no click action.
       * Delegation also works for buttons added later by JavaScript.
       */
      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
 
        const readButton = target.closest('[data-read]');
        if (readButton && !readButton.disabled) {
          event.preventDefault();
          const kind = (readButton.dataset.read || '').toLowerCase();
          if (kind === 'home') {
            readPage(true, $('#home') || $('.page.is-active'));
          } else {
            readPage(true);
          }
          return;
        }
 
        const paragraphButton = target.closest('.read-here');
        if (paragraphButton && !paragraphButton.disabled) {
          event.preventDefault();
          const paragraph = paragraphButton.closest('p');
          if (paragraph) readParagraph(paragraph);
        }
      });
 
      Reader.subscribe(render);
    }
 
    return { init, setOpen, open: () => setOpen(true) };
  })();
 
  /* Read the whole page you are on (chapter or home introduction). */
  function readPage(openPanel = false, targetPage = null) {
    const page = targetPage || $('.page.is-active') || $('.page');
    const area = $('[data-read-area]', page) || page;
    const blocks = collectBlocks(area);
    const title = page.dataset.title || 'this page';
    if (openPanel) ReaderUI.open();
    Reader.start(blocks, { scope: 'page', label: title });
  }
 
  /* Read a single paragraph (the small speaker button beside each paragraph). */
  function readParagraph(paragraph) {
    if (Reader.state !== 'stopped' && Reader.scope === 'paragraph' && Reader.currentBlock === paragraph) {
      Reader.stop();
      return;
    }
    ReaderUI.open();
    Reader.start([paragraph], { scope: 'paragraph', label: 'selected paragraph' });
  }
 
  /* Add a small speaker button to every narrative paragraph. */
  function addParagraphButtons() {
    if (!Reader.supported) return;
    $$('.prose > p').forEach((p) => {
      if (p.classList.contains('read-row') || p.classList.contains('scene-date')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'read-here no-read';
      button.setAttribute('aria-label', 'Read this paragraph aloud');
      button.innerHTML = icon('i-speaker');
      p.prepend(button);
    });
  }
 
 
  /* ------------------------------------------------------------------------
     3. CHAPTER ROUTER, PROGRESS BAR, CHAPTER MENU, PAGERS
     Every chapter is a <section class="page" id="…">. The URL hash picks the
     chapter, so links are real anchors and the back button works.
     ------------------------------------------------------------------------ */
  const Router = (() => {
    const pages = $$('.page');
    const order = pages.map((p) => p.id);
    let currentId = null;
 
    const progressBar = $('#progress-bar');
    const progressEl = $('#progress');
    const progressLabel = $('#progress-label');
    let ticking = false;
 
    /* Work out which chapter, and which element inside it, a hash points to. */
    function resolve() {
      const raw = decodeURIComponent(window.location.hash.slice(1));
      const target = raw ? document.getElementById(raw) : null;
      if (!target) return { pageId: 'home', anchor: null };
      const page = target.closest('.page');
      if (!page) return { pageId: currentId || 'home', anchor: target };   // e.g. #main
      return { pageId: page.id, anchor: page === target ? null : target };
    }
 
    function updateNav() {
      $$('[data-nav] a[href^="#"]').forEach((a) => {
        if (a.getAttribute('href') === `#${currentId}`) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
      const page = document.getElementById(currentId);
      document.title = currentId === 'home'
        ? 'Rizal’s Journey to Heroism'
        : `${page.dataset.title} | Rizal’s Journey to Heroism`;
    }
 
    function show(pageId, anchor, moveFocus) {
      const changed = pageId !== currentId;
      if (changed) {
        Reader.stop();                                   // never carry speech into another chapter
        pages.forEach((p) => {
          const active = p.id === pageId;
          p.hidden = !active;
          p.classList.toggle('is-active', active);
        });
        currentId = pageId;
        updateNav();
        Game.visit(pageId);
      }
      if (anchor) {
        anchor.scrollIntoView({ block: 'start', behavior: changed || prefersReducedMotion() ? 'auto' : 'smooth' });
      } else if (changed) {
        window.scrollTo(0, 0);
      }
      if (moveFocus && changed) {
        const heading = $('.page-title', document.getElementById(pageId));
        if (heading) heading.focus({ preventScroll: true });
      }
      updateProgress();
    }
 
    function onHashChange() {
      const { pageId, anchor } = resolve();
      show(pageId, anchor, true);
    }
 
    /* Reading progress within the active chapter */
    function updateProgress() {
      ticking = false;
      const page = document.getElementById(currentId);
      if (!page) return;
      const rect = page.getBoundingClientRect();
      const scrollable = rect.height - window.innerHeight;
      const pct = scrollable > 0 ? clamp(-rect.top / scrollable, 0, 1) : 1;
      const rounded = Math.round(pct * 100);
      progressBar.style.transform = `scaleX(${pct})`;
      progressEl.setAttribute('aria-valuenow', String(rounded));
      if (pct >= 0.9) Game.complete(currentId);
      const num = page.dataset.num;
      const name = page.dataset.title;
      progressLabel.textContent = currentId === 'home'
        ? `Home, ${rounded}%`
        : `${/^\d+$/.test(num || '') ? `Chapter ${num}: ` : ''}${name}, ${rounded}%`;
    }
 
    function requestProgress() {
      if (!ticking) { ticking = true; window.requestAnimationFrame(updateProgress); }
    }
 
    /* Previous / Home / Next buttons at the end of each chapter */
    function buildPagers() {
      const label = (page) => (page.dataset.num && page.dataset.num !== '§' ? page.dataset.title : page.dataset.title);
      $$('.pager').forEach((nav) => {
        const page = nav.closest('.page');
        const i = order.indexOf(page.id);
        const prev = pages[i - 1];
        const next = pages[i + 1];
        const parts = [];
        parts.push(prev
          ? `<a class="pager-link pager-link--prev" href="#${prev.id}" rel="prev"><span class="pager-dir">${icon('i-prev')} ${prev.id === 'home' ? 'Back to the start' : 'Previous chapter'}</span><span class="pager-title">${label(prev)}</span></a>`
          : '<span></span>');
        parts.push(`<a class="pager-home" href="#home">${icon('i-home')} Home</a>`);
        parts.push(next
          ? `<a class="pager-link pager-link--next" href="#${next.id}" rel="next"><span class="pager-dir">Next chapter ${icon('i-next')}</span><span class="pager-title">${label(next)}</span></a>`
          : '<span></span>');
        nav.innerHTML = parts.join('');
      });
    }
 
    /* Clicking a link to the page you are already on should still scroll. */
    function onLinkClick(event) {
      const link = event.target.closest('a[href^="#"]');
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const id = decodeURIComponent(link.getAttribute('href').slice(1));
      if (window.location.hash === `#${id}` || (!window.location.hash && id === 'home')) {
        const { pageId, anchor } = resolve();
        if (pageId === currentId) {
          event.preventDefault();
          if (anchor) anchor.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          else window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        }
      }
    }
 
    function init() {
      buildPagers();
      window.addEventListener('hashchange', onHashChange);
      window.addEventListener('scroll', requestProgress, { passive: true });
      window.addEventListener('resize', requestProgress);
      document.addEventListener('click', onLinkClick);
      const { pageId, anchor } = resolve();
      show(pageId, anchor, false);
    }
 
    return { init, show, get current() { return currentId; } };
  })();
 
  /* Chapter menu (slide-over dialog) and generic [data-close] buttons */
  function initDialogsCommon() {
    const drawer = $('#drawer');
    $('#menu-btn').addEventListener('click', () => drawer.showModal());
    drawer.addEventListener('click', (event) => {
      if (event.target === drawer || event.target.closest('a[href^="#"]')) drawer.close();
    });
 
    document.addEventListener('click', (event) => {
      const closer = event.target.closest('[data-close]');
      if (closer) {
        const dialog = closer.closest('dialog');
        if (dialog) dialog.close();
      }
    });
  }
 
 
  /* ------------------------------------------------------------------------
     4. “WHY?” AND “HOW?” EXPLANATION DIALOG
     Content lives in <template id="insight-…"> elements in index.html.
     ------------------------------------------------------------------------ */
  const Insights = (() => {
    const dialog = $('#insight-dialog');
    const titleEl = $('#insight-title');
    const kickerEl = $('#insight-kicker');
    const bodyEl = $('#insight-body');
    const listenBtn = $('#insight-listen');
    const pauseBtn = $('#insight-pause');
    let opener = null;
 
    function open(id, trigger) {
      const template = document.getElementById(`insight-${id}`);
      if (!template) return;
      Reader.stop();                                    // one voice at a time
      Game.opened(`ins-${id}`);
      opener = trigger || null;
      bodyEl.replaceChildren(template.content.cloneNode(true));
      titleEl.textContent = template.dataset.title || '';
      kickerEl.textContent = template.dataset.kicker || '';
      bodyEl.scrollTop = 0;
      dialog.showModal();
      titleEl.focus({ preventScroll: true });
    }
 
    function listen() {
      if (Reader.scope === 'insight' && Reader.state !== 'stopped') { Reader.stop(); return; }
      const blocks = collectBlocks(bodyEl);
      Reader.start(blocks, { scope: 'insight', label: titleEl.textContent });
    }
 
    function init() {
      document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-insight]');
        if (button) open(button.dataset.insight, button);
      });
      listenBtn.addEventListener('click', listen);
      pauseBtn.addEventListener('click', () => (Reader.state === 'paused' ? Reader.resume() : Reader.pause()));
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
      dialog.addEventListener('close', () => {
        if (Reader.scope === 'insight') Reader.stop();
        bodyEl.replaceChildren();
        if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
        opener = null;
      });
    }
    return { init };
  })();
 
 
  /* ------------------------------------------------------------------------
     5. IMAGE VIEWER (LIGHTBOX)
     Every figure.ph gets an “open larger view” button. The viewer steps
     through the figures in the same gallery (or, for a single picture, the
     same chapter). Works for placeholders and, later, for real <img> files.
     ------------------------------------------------------------------------ */
  const Lightbox = (() => {
    const dialog = $('#lightbox');
    const stage = $('#lb-stage');
    const captionEl = $('#lb-caption');
    const countEl = $('#lb-count');
    const titleEl = $('#lb-title');
    const prevBtn = $('#lb-prev');
    const nextBtn = $('#lb-next');
    let items = [];
    let index = 0;
    let opener = null;
 
    function figureLabel(fig) {
      const label = $('.ph-label', fig);
      const img = $('img', fig);
      return (label && label.textContent.trim()) || (img && img.alt) || 'Image';
    }
 
    function enhance() {
      $$('figure.ph').forEach((fig) => {
        const frame = $('.ph-frame', fig);
        if (!frame || $('.ph-zoom', frame)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ph-zoom';
        button.setAttribute('aria-label', `Open larger view: ${figureLabel(fig)}`);
        button.innerHTML = icon('i-expand');
        frame.append(button);
      });
    }
 
    function render() {
      const fig = items[index];
      const frame = $('.ph-frame', fig);
      const media = frame.cloneNode(true);
      const zoom = $('.ph-zoom', media);
      if (zoom) zoom.remove();
      media.classList.add('ph-frame--large');
 
      /* Keep the picture’s aspect ratio and fit it inside the dialog. */
      const ar = getComputedStyle(fig).getPropertyValue('--ar').trim() || '4 / 3';
      const [w, h] = ar.split('/').map((n) => parseFloat(n));
      const ratio = w && h ? w / h : 4 / 3;
      media.style.setProperty('--ar', ar);
      const maxByHeight = window.innerHeight * 0.56 * ratio;
      const maxByWidth = Math.max(stage.clientWidth - 56, 220);
      media.style.width = `${Math.round(Math.min(maxByHeight, maxByWidth))}px`;
 
      stage.replaceChildren(media);
      const caption = $('figcaption', fig);
      captionEl.textContent = caption ? caption.textContent.trim() : '';
      titleEl.textContent = figureLabel(fig);
      countEl.textContent = items.length > 1 ? `Picture ${index + 1} of ${items.length}` : 'Picture';
      prevBtn.hidden = nextBtn.hidden = items.length < 2;
    }
 
    function open(fig, trigger) {
      const scope = fig.closest('[data-gallery]') || fig.closest('.page') || document;
      items = scope === fig ? [fig] : $$('figure.ph', scope);
      index = Math.max(0, items.indexOf(fig));
      opener = trigger || null;
      dialog.showModal();
      render();
      titleEl.focus({ preventScroll: true });
    }
 
    function step(delta) {
      if (items.length < 2) return;
      index = (index + delta + items.length) % items.length;
      render();
    }
 
    function init() {
      enhance();
      document.addEventListener('click', (event) => {
        const zoom = event.target.closest('.ph-zoom');
        if (zoom) open(zoom.closest('figure.ph'), zoom);
      });
      prevBtn.addEventListener('click', () => step(-1));
      nextBtn.addEventListener('click', () => step(1));
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
      });
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
      dialog.addEventListener('close', () => {
        stage.replaceChildren();
        if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
        opener = null;
      });
      window.addEventListener('resize', () => { if (dialog.open) render(); });
    }
    return { init };
  })();
 
 
  /* ------------------------------------------------------------------------
     6. TIMELINE, TABS, SAVED REFLECTION NOTES
     ------------------------------------------------------------------------ */
 
  /* Home-page timeline: select a milestone, read it, jump to its chapter. */
  function initTimeline() {
    $$('[data-timeline]').forEach((root) => {
      const buttons = $$('.tl-btn', root);
      const yearEl = $('.tl-d-year', root);
      const titleEl = $('.tl-d-title', root);
      const textEl = $('.tl-d-text', root);
      const link = $('.tl-d-link', root);
 
      function select(button) {
        buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        const item = button.closest('.tl-item');
        const chapter = document.getElementById(button.dataset.chapter);
        yearEl.textContent = $('.tl-year', button).textContent;
        titleEl.textContent = $('.tl-label', button).textContent;
        textEl.textContent = $('.tl-desc', item).textContent;
        link.href = `#${button.dataset.chapter}`;
        link.textContent = chapter ? `Open chapter: ${chapter.dataset.title}` : 'Open the chapter';
      }
 
      buttons.forEach((button) => {
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => select(button));
      });
      if (buttons.length) select(buttons[0]);
    });
  }
 
  /* Accessible tabs (used for “Following the thread” in Chapter 8).
     Arrow keys, Home and End move between tabs. */
  function initTabs() {
    $$('[data-tabs]').forEach((root) => {
      const tabs = $$('[role="tab"]', root);
      const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
 
      function select(index, focus) {
        tabs.forEach((tab, i) => {
          const active = i === index;
          tab.setAttribute('aria-selected', String(active));
          tab.tabIndex = active ? 0 : -1;
          panels[i].hidden = !active;
        });
        if (focus) tabs[index].focus();
      }
 
      tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => { Reader.stop(); select(i, false); });
        tab.addEventListener('keydown', (event) => {
          const last = tabs.length - 1;
          let next = null;
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = i === last ? 0 : i + 1;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = i === 0 ? last : i - 1;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = last;
          if (next !== null) { event.preventDefault(); Reader.stop(); select(next, true); }
        });
      });
      select(0, false);
    });
  }
 
  /* Reflection answers are kept in this browser only. */
  function initNotes() {
    $$('textarea[data-save]').forEach((area) => {
      area.value = storage.get(area.dataset.save, '');
      let timer = 0;
      area.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => storage.set(area.dataset.save, area.value), 400);
      });
    });
  }
 
 
 
 
  /* ------------------------------------------------------------------------
     6b. ENGAGEMENT: XP, levels, streaks, badges, toasts, confetti
     Progress is stored in this browser only (localStorage).
     ------------------------------------------------------------------------ */
  const CHAPTER_IDS = ['young-rizal', 'learner', 'traveler', 'writer', 'reformer', 'exile', 'final-journey', 'hero'];
  const chapterName = (id) => {
    const page = document.getElementById(id);
    if (!page) return id;
    return /^\d+$/.test(page.dataset.num || '') ? `${page.dataset.num}. ${page.dataset.title}` : page.dataset.title;
  };
 
  function toast(text, kind) {
    const host = $('#toasts');
    if (!host) return;
    while (host.children.length >= 3) host.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = `toast${kind === 'badge' ? ' is-badge' : ''}`;
    el.innerHTML = `${icon(kind === 'badge' ? 'i-star' : 'i-flame')}<span></span>`;
    el.lastElementChild.textContent = text;
    host.append(el);
    setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 320); }, 2600);
  }
 
  function confetti(count = 46) {
    if (prefersReducedMotion()) return;
    const box = document.createElement('div');
    box.className = 'confetti';
    box.setAttribute('aria-hidden', 'true');
    const colors = ['#ffc83d', '#ff7a59', '#35c2a1', '#6c63ff', '#3aa7ff', '#8fd16f'];
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('i');
      piece.style.setProperty('--x', `${Math.random() * 100}%`);
      piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 240}px`);
      piece.style.setProperty('--r', `${Math.random() * 360}deg`);
      piece.style.setProperty('--t', `${1.8 + Math.random() * 1.4}s`);
      piece.style.setProperty('--dl', `${Math.random() * 0.4}s`);
      piece.style.setProperty('--c', colors[i % colors.length]);
      box.append(piece);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 3800);
  }
 
  const Game = (() => {
    const KEY = 'rizal.game.v2';
    const LEVELS = [[0, 'Curious Reader'], [60, 'Page Turner'], [160, 'History Explorer'], [320, 'Archive Scholar'], [540, 'Rizal Researcher'], [820, 'Keeper of the Story']];
    const BADGES = {
      'ch-young-rizal': ['Calamba Kid', 'Finish Chapter 1'], 'ch-learner': ['Bookworm', 'Finish Chapter 2'], 'ch-traveler': ['Voyager', 'Finish Chapter 3'],
      'ch-writer': ['Inkwell', 'Finish Chapter 4'], 'ch-reformer': ['Reformer', 'Finish Chapter 5'], 'ch-exile': ['Dapitan Doer', 'Finish Chapter 6'],
      'ch-final-journey': ['Witness', 'Finish Chapter 7'], 'ch-hero': ['Storykeeper', 'Finish Chapter 8'],
      'first-quiz': ['Quiz Rookie', 'Finish your first quiz'], 'quiz-ace': ['Quiz Ace', 'Score 7 of 8 or better'], 'timeline-master': ['Time Traveler', 'Order a timeline perfectly'],
      'curious': ['Curious Mind', 'Ask Pluma a question'], 'deep-diver': ['Deep Diver', 'Open 6 “Go deeper” or “Why?” cards'], 'listener': ['Good Listener', 'Use the voice reader'], 'card-sharp': ['Card Sharp', 'Mark 20 flashcards “Got it”'],
    };
    const blank = () => ({ xp: 0, streak: 0, lastDay: '', badges: {}, done: {}, seen: {}, once: {}, good: 0 });
    let s = blank();
    try { s = Object.assign(blank(), JSON.parse(storage.get(KEY, '{}'))); } catch (err) { s = blank(); }
    const save = () => storage.set(KEY, JSON.stringify(s));
    const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
 
    function levelInfo(xp = s.xp) {
      let i = 0;
      LEVELS.forEach((l, idx) => { if (xp >= l[0]) i = idx; });
      const next = LEVELS[i + 1];
      const pct = next ? (xp - LEVELS[i][0]) / (next[0] - LEVELS[i][0]) : 1;
      return { level: i + 1, name: LEVELS[i][1], pct, toNext: next ? next[0] - xp : 0 };
    }
 
    function render() {
      const info = levelInfo();
      const btn = $('#xp-btn');
      if (!btn) return;
      $('#xp-level').textContent = `Lv ${info.level}`;
      $('#xp-total').textContent = `${s.xp} XP`;
      $('#xp-fill').style.width = `${Math.round(info.pct * 100)}%`;
      btn.setAttribute('aria-label', `Your progress: level ${info.level}, ${info.name}, ${s.xp} XP, ${s.streak} day streak. Open for badges.`);
      $$('.chap-card[data-theme]').forEach((card) => {
        const id = (card.querySelector('a') || {}).getAttribute && card.querySelector('a').getAttribute('href').slice(1);
        card.classList.toggle('is-done', !!s.done[id]);
      });
      $$('.drawer-list a').forEach((a) => a.classList.toggle('is-done', !!s.done[a.getAttribute('href').slice(1)]));
    }
 
    function award(n, label, onceKey) {
      if (onceKey) { if (s.once[onceKey]) return false; s.once[onceKey] = 1; }
      const before = levelInfo().level;
      s.xp += n;
      save(); render();
      toast(`+${n} XP${label ? `: ${label}` : ''}`);
      const btn = $('#xp-btn');
      if (btn) { btn.classList.remove('is-bump'); void btn.offsetWidth; btn.classList.add('is-bump'); }
      const after = levelInfo();
      if (after.level > before) { setTimeout(() => { toast(`Level up! You are now ${after.name}`, 'badge'); confetti(60); }, 700); }
      return true;
    }
 
    function badge(id) {
      if (s.badges[id] || !BADGES[id]) return;
      s.badges[id] = 1; save();
      setTimeout(() => { toast(`Badge unlocked: ${BADGES[id][0]}`, 'badge'); confetti(40); }, 500);
    }
 
    function visit(pageId) {
      if (!CHAPTER_IDS.includes(pageId)) return;
      if (!s.seen[pageId]) { s.seen[pageId] = 1; save(); award(5, 'new chapter'); }
    }
    function complete(pageId) {
      if (!CHAPTER_IDS.includes(pageId) || s.done[pageId]) return;
      s.done[pageId] = 1; save();
      award(20, 'chapter complete');
      badge(`ch-${pageId}`);
      render();
    }
    function opened(key) {
      if (!award(2, 'curious!', `open-${key}`)) return;
      const count = Object.keys(s.once).filter((k) => k.startsWith('open-')).length;
      if (count >= 6) badge('deep-diver');
    }
    function good() { s.good += 1; save(); if (s.good >= 20) badge('card-sharp'); }
 
    function streakTick() {
      const t = today();
      if (s.lastDay === t) return;
      const y = new Date(); y.setDate(y.getDate() - 1);
      const yesterday = `${y.getFullYear()}-${y.getMonth() + 1}-${y.getDate()}`;
      s.streak = s.lastDay === yesterday ? s.streak + 1 : 1;
      s.lastDay = t; save();
    }
 
    function openDialog() {
      const dlg = $('#progress-dialog');
      const info = levelInfo();
      $('#pg-title').textContent = `Level ${info.level}: ${info.name}`;
      const chapters = CHAPTER_IDS.map((id) => `<li class="${s.done[id] ? 'is-on' : ''}">${icon(s.done[id] ? 'i-check' : 'i-star')}<span>${chapterName(id)}</span></li>`).join('');
      const badges = Object.keys(BADGES).map((id) => `<li class="${s.badges[id] ? 'is-on' : ''}"><b>${s.badges[id] ? '' : 'Locked: '}${BADGES[id][0]}</b><small>${BADGES[id][1]}</small></li>`).join('');
      $('#pg-body').innerHTML = `
        <div class="pg-xpbar" role="img" aria-label="${Math.round(info.pct * 100)} percent to the next level"><span style="width:${Math.round(info.pct * 100)}%"></span></div>
        <p class="pg-line"><span>${s.xp} XP</span><span>${info.toNext ? `${info.toNext} XP to next level` : 'Top level reached'}</span></p>
        <p class="pg-line"><span>${icon('i-flame')} Day streak: ${s.streak}</span><span>Badges: ${Object.keys(s.badges).length} of ${Object.keys(BADGES).length}</span></p>
        <h3>Chapters finished</h3><ul class="pg-grid">${chapters}</ul>
        <h3>Badges</h3><ul class="pg-grid pg-badges">${badges}</ul>
        <p class="note-interp">Progress is saved only in this browser. A chapter counts as finished when you scroll through most of it.</p>`;
      dlg.showModal();
      $('#pg-title').focus({ preventScroll: true });
    }
 
    function init() {
      streakTick();
      render();
      $('#xp-btn').addEventListener('click', openDialog);
      $('#pg-reset').addEventListener('click', () => {
        if (window.confirm('Reset all XP, badges, and chapter progress on this device?')) { s = blank(); streakTick(); save(); render(); $('#progress-dialog').close(); }
      });
      /* Listening for the first time earns a badge. */
      Reader.subscribe((snap) => { if (snap.state === 'playing' && snap.scope !== 'insight') { if (award(3, 'listening along', 'listen')) badge('listener'); } });
      /* Opening any “Go deeper” or “Did you know?” card */
      document.addEventListener('toggle', (event) => {
        const el = event.target;
        if (el.matches && el.matches('details.dive, details.dyk') && el.open) opened(`d-${(el.querySelector('summary') || {}).textContent}`);
      }, true);
    }
    return { init, award, badge, visit, complete, opened, good, confetti: () => confetti(), render };
  })();
 
 
  /* ------------------------------------------------------------------------
     6c. REVIEW TAB: flashcards, quiz, timeline challenge, key terms, fact bank
     ------------------------------------------------------------------------ */
  const Review = (() => {
    const D = window.RIZAL;
    const chapterSelect = $('#rv-chapter');
    const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const refLinks = (refs) => refs.map((n) => `<a href="#ref-r${n}" title="${(D.refLabels[n] || '').replace(/"/g, '&quot;')}">[${n}]</a>`).join(' ');
    const inPool = (arr) => (chapterSelect.value === 'all' ? arr : arr.filter((x) => x.ch === chapterSelect.value));
 
    /* ---- Flashcards ---- */
    const fc = { deck: [], i: 0, flipped: false, level: {} };
    const fcEls = { card: $('#fc-card'), q: $('#fc-q'), a: $('#fc-a'), chip: $('#fc-chip'), src: $('#fc-src'), count: $('#fc-count'), known: $('#fc-known') };
    try { fc.level = JSON.parse(storage.get('rizal.fc', '{}')); } catch (err) { fc.level = {}; }
 
    function buildDeck() {
      const pool = inPool(D.flash);
      fc.deck = shuffle(pool).sort((a, b) => (fc.level[a.id] || 0) - (fc.level[b.id] || 0));
      fc.i = 0; fc.flipped = false;
      renderCard();
    }
    function renderCard() {
      const card = fc.deck[fc.i];
      if (!card) { fcEls.q.textContent = 'No cards for this chapter yet.'; fcEls.a.textContent = ''; fcEls.count.textContent = 'Card 0 of 0'; return; }
      fcEls.card.classList.toggle('is-flipped', fc.flipped);
      fcEls.q.textContent = card.q;
      fcEls.a.textContent = card.a;
      fcEls.chip.textContent = chapterName(card.ch);
      fcEls.src.textContent = `Sources: ${card.refs.join(', ')}`;
      fcEls.count.textContent = `Card ${fc.i + 1} of ${fc.deck.length}`;
      const mastered = fc.deck.filter((c) => (fc.level[c.id] || 0) >= 2).length;
      fcEls.known.textContent = `${mastered} mastered`;
      $('.fc-front', fcEls.card).setAttribute('aria-hidden', String(fc.flipped));
      $('.fc-back', fcEls.card).setAttribute('aria-hidden', String(!fc.flipped));
      fcEls.card.setAttribute('aria-label', fc.flipped ? `Answer: ${card.a}. Press to see the question.` : `Question: ${card.q}. Press to reveal the answer.`);
    }
    function fcMove(delta) { fc.i = (fc.i + delta + fc.deck.length) % Math.max(fc.deck.length, 1); fc.flipped = false; renderCard(); }
    function fcRate(good) {
      const card = fc.deck[fc.i];
      if (!card) return;
      fc.level[card.id] = good ? Math.min(3, (fc.level[card.id] || 0) + 1) : 0;
      storage.set('rizal.fc', JSON.stringify(fc.level));
      if (good) { Game.award(2, 'got it'); Game.good(); }
      fcMove(1);
    }
    function initFlash() {
      fcEls.card.addEventListener('click', () => { fc.flipped = !fc.flipped; renderCard(); });
      $('#fc-next').addEventListener('click', () => fcMove(1));
      $('#fc-prev').addEventListener('click', () => fcMove(-1));
      $('#fc-good').addEventListener('click', () => fcRate(true));
      $('#fc-again').addEventListener('click', () => fcRate(false));
      $('#fc-shuffle').addEventListener('click', buildDeck);
      $('#rv-flash').addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') { event.preventDefault(); fcMove(1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); fcMove(-1); }
      });
    }
 
    /* ---- Quiz ---- */
    const qz = { qs: [], i: 0, correct: 0, missed: [], locked: false };
    const qzEls = { start: $('#qz-start'), run: $('#qz-run'), end: $('#qz-end'), num: $('#qz-num'), score: $('#qz-score'), bar: $('#qz-barfill'), q: $('#qz-q'), opts: $('#qz-opts'), fb: $('#qz-fb'), next: $('#qz-nextbtn') };
    const QUIZ_LEN = 8;
 
    function quizStart() {
      const pool = inPool(D.quiz);
      qz.qs = shuffle(pool).slice(0, QUIZ_LEN).map((q) => {
        const opts = shuffle(q.options.map((text, idx) => ({ text, ok: idx === q.answer })));
        return Object.assign({}, q, { opts });
      });
      qz.i = 0; qz.correct = 0; qz.missed = [];
      qzEls.start.hidden = true; qzEls.end.hidden = true; qzEls.run.hidden = false;
      quizShow();
    }
    function quizShow() {
      const q = qz.qs[qz.i];
      qz.locked = false;
      qzEls.num.textContent = `Question ${qz.i + 1} of ${qz.qs.length}`;
      qzEls.score.textContent = `${qz.correct} correct`;
      qzEls.bar.style.width = `${(qz.i / qz.qs.length) * 100}%`;
      qzEls.q.textContent = q.q;
      qzEls.fb.hidden = true; qzEls.next.hidden = true;
      qzEls.opts.replaceChildren(...q.opts.map((o, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'qz-opt';
        b.innerHTML = `<span class="qz-key" aria-hidden="true">${'ABCD'[i]}</span><span></span>`;
        b.lastElementChild.textContent = o.text;
        b.addEventListener('click', () => quizAnswer(i));
        return b;
      }));
      qzEls.q.focus({ preventScroll: true });
    }
    function quizAnswer(i) {
      if (qz.locked) return;
      qz.locked = true;
      const q = qz.qs[qz.i];
      const ok = q.opts[i].ok;
      $$('.qz-opt', qzEls.opts).forEach((b, idx) => {
        b.disabled = true;
        if (q.opts[idx].ok) b.classList.add('is-correct');
        else if (idx === i) b.classList.add('is-wrong'); else b.classList.add('is-dim');
      });
      if (ok) { qz.correct += 1; Game.award(5, 'correct'); } else { qz.missed.push(q); }
      qzEls.score.textContent = `${qz.correct} correct`;
      qzEls.fb.className = `qz-fb ${ok ? 'is-good' : 'is-bad'}`;
      qzEls.fb.innerHTML = `<strong>${ok ? 'Correct!' : 'Not quite.'}</strong><span></span><p class="fact-src">Sources: ${refLinks(q.refs)}</p>`;
      qzEls.fb.querySelector('span').textContent = q.why;
      qzEls.fb.hidden = false;
      qzEls.next.textContent = qz.i === qz.qs.length - 1 ? 'See my results' : 'Next question';
      qzEls.next.hidden = false;
      qzEls.next.focus({ preventScroll: false });
    }
    function quizNext() {
      qz.i += 1;
      if (qz.i < qz.qs.length) { quizShow(); return; }
      quizEnd();
    }
    function quizEnd() {
      qzEls.run.hidden = true; qzEls.end.hidden = false;
      qzEls.bar.style.width = '100%';
      const total = qz.qs.length;
      const pct = qz.correct / total;
      const msg = pct === 1 ? 'Perfect score! Pluma is doing a happy dance.' : pct >= 0.75 ? 'Great work! You know your Rizal.' : pct >= 0.5 ? 'Good start. Review the missed ones and try again.' : 'Keep going. The flashcards will help.';
      Game.award(10, 'quiz finished', null);
      if (qz.correct === total) Game.award(20, 'perfect score');
      Game.badge('first-quiz');
      if (qz.correct >= Math.min(7, total)) Game.badge('quiz-ace');
      if (pct >= 0.75) Game.confetti();
      const missed = qz.missed.map((q) => `<li><b></b> <span></span> <span class="fact-src">Sources: ${refLinks(q.refs)}</span></li>`).join('');
      qzEls.end.innerHTML = `<h2>Quiz complete</h2><p class="qz-score-big">${qz.correct} / ${total}</p><p>${msg}</p>
        ${qz.missed.length ? `<div class="qz-missed"><b>To review:</b><ul>${missed}</ul></div>` : ''}
        <button type="button" class="btn btn--primary" id="qz-again">Play again</button>
        <button type="button" class="btn btn--ghost" id="qz-toflash">Study flashcards</button>`;
      $$('.qz-missed li', qzEls.end).forEach((li, idx) => {
        const q = qz.missed[idx];
        li.querySelector('b').textContent = q.q;
        li.querySelector('span').textContent = `Answer: ${q.opts.find((o) => o.ok).text}. ${q.why}`;
      });
      $('#qz-again').addEventListener('click', quizStart);
      $('#qz-toflash').addEventListener('click', () => $('#rvt-flash').click());
      $('h2', qzEls.end).setAttribute('tabindex', '-1');
      $('h2', qzEls.end).focus({ preventScroll: true });
    }
    function initQuiz() {
      $('#qz-go').addEventListener('click', quizStart);
      qzEls.next.addEventListener('click', quizNext);
      $('#rv-quiz').addEventListener('keydown', (event) => {
        if (!qzEls.run.hidden && !qz.locked && /^[1-4]$/.test(event.key)) {
          const idx = Number(event.key) - 1;
          if (idx < qz.qs[qz.i].opts.length) quizAnswer(idx);
        }
      });
      chapterSelect.addEventListener('change', () => { qzEls.start.hidden = false; qzEls.run.hidden = true; qzEls.end.hidden = true; });
    }
 
    /* ---- Timeline challenge ---- */
    const og = { set: 0, order: [], checked: false };
    const ogList = $('#og-list');
    function ogNew(next) {
      if (next) og.set = (og.set + 1) % D.orderSets.length;
      const events = D.orderSets[og.set].events;
      let order;
      do { order = shuffle(events.map((_, i) => i)); } while (order.every((v, i) => i === 0 || events[order[i - 1]][2] <= events[v][2]));
      og.order = order; og.checked = false;
      $('#og-result').textContent = '';
      ogRender();
    }
    function ogRender(focusIndex, focusDir) {
      const events = D.orderSets[og.set].events;
      ogList.replaceChildren(...og.order.map((evIdx, pos) => {
        const [title, year] = events[evIdx];
        const li = document.createElement('li');
        li.className = 'og-item';
        li.innerHTML = '<span class="og-text"></span><span class="og-year" hidden></span><span class="og-move"><button type="button" data-d="-1">↑</button><button type="button" data-d="1">↓</button></span>';
        li.querySelector('.og-text').textContent = title;
        const y = li.querySelector('.og-year'); y.textContent = year;
        li.querySelector('[data-d="-1"]').setAttribute('aria-label', `Move up: ${title}`);
        li.querySelector('[data-d="1"]').setAttribute('aria-label', `Move down: ${title}`);
        li.querySelector('[data-d="-1"]').disabled = pos === 0;
        li.querySelector('[data-d="1"]').disabled = pos === og.order.length - 1;
        if (og.checked) {
          const sorted = og.order.slice().sort((a, b) => events[a][2] - events[b][2]);
          li.classList.add(sorted[pos] === evIdx ? 'is-right' : 'is-wrong');
          y.hidden = false;
        }
        li.dataset.pos = pos;
        return li;
      }));
      if (focusIndex !== undefined) {
        const item = ogList.children[focusIndex];
        const btn = item && item.querySelector(`[data-d="${focusDir}"]:not([disabled])`) || item && item.querySelector('button:not([disabled])');
        if (btn) btn.focus();
      }
    }
    function initOrder() {
      ogList.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-d]');
        if (!btn) return;
        const pos = Number(btn.closest('.og-item').dataset.pos);
        const dir = Number(btn.dataset.d);
        const to = pos + dir;
        if (to < 0 || to >= og.order.length) return;
        [og.order[pos], og.order[to]] = [og.order[to], og.order[pos]];
        og.checked = false; $('#og-result').textContent = '';
        ogRender(to, dir);
      });
      $('#og-check').addEventListener('click', () => {
        const events = D.orderSets[og.set].events;
        og.checked = true;
        const sorted = og.order.slice().sort((a, b) => events[a][2] - events[b][2]);
        const right = og.order.filter((v, i) => sorted[i] === v).length;
        ogRender();
        const result = $('#og-result');
        if (right === og.order.length) {
          result.textContent = 'Perfect order! Every event is in the right place.';
          Game.award(15, 'timeline mastered'); Game.badge('timeline-master'); Game.confetti();
        } else {
          result.textContent = `${right} of ${og.order.length} are in the right place. The years are shown so you can fix the rest.`;
          if (right) Game.award(right, 'timeline');
        }
      });
      $('#og-new').addEventListener('click', () => ogNew(true));
      ogNew(false);
    }
 
    /* ---- Key terms and fact bank ---- */
    function renderTerms() {
      const q = $('#terms-search').value.trim().toLowerCase();
      const list = D.glossary.filter((g) => !q || g.term.toLowerCase().includes(q) || g.def.toLowerCase().includes(q));
      $('#terms').replaceChildren(...list.map((g) => {
        const div = document.createElement('div');
        div.innerHTML = '<dt></dt><dd></dd>';
        div.querySelector('dt').textContent = g.term;
        div.querySelector('dd').innerHTML = '<span></span> <span class="fact-src">Sources: ' + refLinks(g.refs) + '</span>';
        div.querySelector('dd span').textContent = g.def;
        return div;
      }));
      if (!list.length) $('#terms').innerHTML = '<p>No matching terms.</p>';
    }
    function renderFacts() {
      const q = $('#facts-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const list = inPool(D.facts).filter((f) => q.every((w) => (f.text + ' ' + f.kw).toLowerCase().includes(w)));
      $('#facts-count').textContent = `Showing ${list.length} of ${D.facts.length} verified facts`;
      $('#factlist').replaceChildren(...list.map((f) => {
        const li = document.createElement('li');
        li.className = 'fact';
        li.innerHTML = '<span></span><div class="fact-meta"><span class="fm-id"></span><span class="fm-ch"></span><span class="fm-src">Sources: </span></div>';
        li.querySelector('span').textContent = f.text;
        li.querySelector('.fm-id').textContent = f.id;
        li.querySelector('.fm-ch').textContent = chapterName(f.ch);
        li.querySelector('.fm-src').innerHTML = 'Sources: ' + refLinks(f.refs);
        return li;
      }));
    }
 
    function init() {
      if (!D) { $('#review .chapter-body').insertAdjacentHTML('afterbegin', '<p class="note-interp">The review data file (data.js) did not load. Check that data.js is next to index.html.</p>'); return; }
      initFlash(); initQuiz(); initOrder();
      buildDeck(); renderTerms(); renderFacts();
      chapterSelect.addEventListener('change', () => { buildDeck(); renderFacts(); });
      $('#terms-search').addEventListener('input', renderTerms);
      $('#facts-search').addEventListener('input', renderFacts);
    }
    return { init, setChapter(id) { chapterSelect.value = id; chapterSelect.dispatchEvent(new Event('change')); } };
  })();
 
 
  /* ------------------------------------------------------------------------
     6d. ASK PLUMA: Rizal-only, fact-grounded assistant
     Modes:  proxy (server.js keeps the Gemini key)  |  your own Gemini key (this tab)  |  fact finder (no AI)
     The AI never sees anything except the retrieved verified facts, and the
     system prompt (in data.js) tells it to refuse other topics and to admit gaps.
     ------------------------------------------------------------------------ */
  const AI_MODEL = 'gemini-2.5-flash';        // default for "my own key" mode; editable in AI settings
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const Ask = (() => {
    const D = window.RIZAL;
    const log = $('#chat-log');
    const form = $('#ask-form');
    const input = $('#ask-input');
    const sendBtn = $('#ask-send');
    const modeEl = $('#ask-mode');
    const ctxEl = $('#ask-ctx');
    const dlg = $('#ai-dialog');
    let pref = storage.get('rizal.ai.mode', 'auto');
    let proxyOK = false;
    let busy = false;
    let ctx = null;
    const history = [];
 
    const getModel = () => storage.get('rizal.ai.model', AI_MODEL) || AI_MODEL;
    const getKey = () => { try { return window.sessionStorage.getItem('rizal.ai.key') || ''; } catch (err) { return ''; } };
    const setKey = (k) => { try { if (k) window.sessionStorage.setItem('rizal.ai.key', k); else window.sessionStorage.removeItem('rizal.ai.key'); } catch (err) { /* ignore */ } };
 
    function mode() {
      if (pref === 'off') return 'facts';
      if (pref === 'key' && getKey()) return 'key';
      if (pref === 'auto' && proxyOK) return 'proxy';
      return 'facts';
    }
    function renderMode() {
      const m = mode();
      modeEl.className = `mode-badge ${m === 'facts' ? 'is-facts' : 'is-ai'}`;
      modeEl.textContent = m === 'proxy' ? 'AI connected (site helper)' : m === 'key' ? 'AI connected (your key)' : 'Fact finder (no AI connected)';
    }
    async function detectProxy() {
      proxyOK = false;
      if (!/^https?:$/.test(window.location.protocol)) { renderMode(); return; }
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const res = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(t);
        const data = await res.json();
        proxyOK = !!(data && data.ok && data.ai);
      } catch (err) { proxyOK = false; }
      renderMode();
    }
 
    /* ---- message helpers ---- */
    function addMessage(role) {
      const li = document.createElement('li');
      li.className = `msg msg--${role}`;
      li.innerHTML = (role === 'bot' ? `<svg class="pluma" aria-hidden="true"><use href="#pluma"/></svg>` : '') + '<div class="bubble"></div>';
      log.append(li);
      log.scrollTop = log.scrollHeight;
      return $('.bubble', li);
    }
    const say = (text) => { const b = addMessage('bot'); const p = document.createElement('p'); p.textContent = text; b.append(p); return b; };
    function typing() { const b = addMessage('bot'); b.innerHTML = '<span class="typing" role="status" aria-label="Pluma is thinking"><i></i><i></i><i></i></span>'; return b.closest('.msg'); }
 
    function sourceChips(ids) {
      const facts = ids.map((id) => D.factsById[id]).filter(Boolean);
      const refs = Array.from(new Set(facts.flatMap((f) => f.refs))).sort((a, b) => a - b);
      return { facts, refs };
    }
 
    function renderAnswer(bubble, text, ids, note) {
      const p = document.createElement('p');
      p.textContent = text.replace(/\s*\n+\s*/g, ' ');
      if (Reader.supported) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'read-here no-read'; btn.setAttribute('aria-label', 'Listen to this answer');
        btn.innerHTML = icon('i-speaker');
        p.prepend(btn);
      }
      bubble.append(p);
      const { facts, refs } = sourceChips(ids);
      if (facts.length) {
        const meta = document.createElement('div');
        meta.className = 'answer-meta no-read';
        meta.innerHTML = 'Sources: ' + refs.map((n) => `<a href="#ref-r${n}" title="${(D.refLabels[n] || '').replace(/"/g, '&quot;')}">[${n}]</a>`).join(' ');
        bubble.append(meta);
        const det = document.createElement('details');
        det.className = 'used no-read';
        det.innerHTML = '<summary>Facts used</summary><ul></ul>';
        facts.forEach((f) => { const li = document.createElement('li'); li.textContent = f.text; det.querySelector('ul').append(li); });
        bubble.append(det);
      }
      if (note) { const n = document.createElement('div'); n.className = 'answer-meta no-read'; n.innerHTML = '<span class="tag-note"></span>'; n.firstChild.textContent = note; bubble.append(n); }
    }
 
    /* ---- Fact-finder answer (no AI) ---- */
    function factFinder(question) {
      const results = D.retrieve(question, ctx, 6);
      const bubble = addMessage('bot');
      if (D.isCovered(results)) {
        const top = results.filter((r) => r.score >= Math.max(2, results[0].score * 0.55)).slice(0, 3).map((r) => r.fact);
        const intro = document.createElement('p');
        intro.textContent = 'Here is what the verified fact bank says:';
        const ul = document.createElement('ul');
        top.forEach((f) => { const li = document.createElement('li'); li.textContent = f.text; ul.append(li); });
        bubble.append(intro, ul);
        const { refs } = sourceChips(top.map((f) => f.id));
        const meta = document.createElement('div');
        meta.className = 'answer-meta no-read';
        meta.innerHTML = 'Sources: ' + refs.map((n) => `<a href="#ref-r${n}" title="${(D.refLabels[n] || '').replace(/"/g, '&quot;')}">[${n}]</a>`).join(' ') + ' <span class="tag-note">Fact finder: no AI wording.</span>';
        bubble.append(meta);
        history.push({ role: 'assistant', content: top.map((f) => f.text).join(' ') });
      } else {
        refuse(bubble, 'I can only answer questions about José Rizal, and I could not find that in the verified fact bank. Try rephrasing, ask one of the questions below, or search the Fact bank under Review.');
      }
    }
    function refuse(bubble, text) {
      const p = document.createElement('p'); p.textContent = text; bubble.append(p);
      renderSuggestions();
    }
 
    /* ---- AI calls ---- */
    async function callProxy(question, prior) {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, history: prior.slice(-6), chapter: ctx }) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Server error ${res.status}`); }
      return res.json();                                    // { off, text, ids }
    }
    /* Direct Gemini call from the browser (your own key, kept in this tab only). */
    async function geminiRequest(body) {
      const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(getModel())}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': getKey() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const hint = res.status === 429 ? ' (quota reached, try again in a minute)' : res.status === 400 || res.status === 403 ? ' (check the API key and model name)' : '';
        throw new Error(((e.error && e.error.message) || `Gemini error ${res.status}`).slice(0, 140) + hint);
      }
      return res.json();
    }
    async function callDirect(question, prior) {
      const facts = D.factsForPrompt(question, ctx);
      const reply = D.geminiText(await geminiRequest(D.buildGeminiRequest(question, prior, facts)));
      if (!reply.text) throw new Error(`the AI returned no answer (${reply.reason})`);
      return D.parseAnswer(reply.text, new Set(facts.map((f) => f.id)));
    }
 
    async function ask(question) {
      question = question.trim().replace(/\s+/g, ' ').slice(0, 400);
      if (!question || busy) return;
      busy = true; sendBtn.disabled = true;
      const u = addMessage('user'); u.textContent = question;
      $('#ask-suggest').hidden = true;
      const wait = typing();
      const m = mode();
      const prior = history.slice();                          // earlier turns only
      history.push({ role: 'user', content: question });      // user turn first, then the answer
      try {
        if (m === 'facts') { await new Promise((r) => setTimeout(r, 350)); wait.remove(); factFinder(question); }
        else {
          const out = m === 'proxy' ? await callProxy(question, prior) : await callDirect(question, prior);
          wait.remove();
          const bubble = addMessage('bot');
          if (out.off) { refuse(bubble, 'I can only answer questions about José Rizal and his times. Try asking about his life, his writings, or how he is remembered.'); }
          else if (!out.text) { refuse(bubble, 'I do not have a verified answer for that. Try the Fact bank under Review, or check the References page.'); }
          else { renderAnswer(bubble, out.text, out.ids || []); history.push({ role: 'assistant', content: out.text }); }
        }
        if (Game.award(10, 'first question to Pluma', 'ask1')) Game.badge('curious'); else Game.award(1, 'asked Pluma', `ask-${Math.min(history.length, 40)}`);
      } catch (err) {
        wait.remove();
        const bubble = addMessage('bot');
        const p = document.createElement('p');
        p.textContent = `The AI could not be reached (${err.message}). Showing the fact finder instead.`;
        bubble.append(p);
        factFinder(question);
      } finally {
        busy = false; sendBtn.disabled = false; log.scrollTop = log.scrollHeight; input.focus({ preventScroll: true });
      }
    }
 
    function renderSuggestions() {
      const box = $('#ask-suggest');
      box.hidden = false;
      box.replaceChildren(...D.suggestions.slice(0, 6).map((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'chip'; b.textContent = s;
        b.addEventListener('click', () => ask(s));
        return b;
      }));
    }
 
    function setContext(id) {
      ctx = id || null;
      ctxEl.hidden = !ctx;
      if (ctx) {
        ctxEl.innerHTML = '<span></span><button type="button" aria-label="Clear chapter focus">×</button>';
        ctxEl.firstChild.textContent = `Focus: ${chapterName(ctx)}`;
        ctxEl.querySelector('button').addEventListener('click', () => setContext(null));
      }
    }
 
    /* ---- settings dialog ---- */
    function openSettings() {
      $$('input[name="ai-mode"]').forEach((r) => { r.checked = r.value === pref; });
      $('#ai-key').value = getKey();
      $('#ai-model').value = getModel();
      $('#ai-test').textContent = '';
      dlg.showModal();
      $('#ai-title').focus({ preventScroll: true });
    }
    async function testConnection() {
      const out = $('#ai-test');
      const chosen = ($('input[name="ai-mode"]:checked') || {}).value;
      out.textContent = 'Testing…';
      try {
        if (chosen === 'auto') { await detectProxy(); out.textContent = proxyOK ? 'Connected to the site AI helper.' : 'No site helper found. Start the site with node server.js (with GEMINI_API_KEY set) and open http://localhost:3000.'; }
        else if (chosen === 'key') {
          setKey($('#ai-key').value.trim());
          storage.set('rizal.ai.model', ($('#ai-model').value.trim() || AI_MODEL));
          const data = await geminiRequest({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { temperature: 0, maxOutputTokens: 200 } });
          const reply = D.geminiText(data);
          out.textContent = reply.text ? `Your Gemini key works with ${getModel()}.` : `The key was accepted, but the model returned no text (${reply.reason}).`;
        } else { out.textContent = 'Fact finder mode needs no connection.'; }
      } catch (err) { out.textContent = `Could not connect: ${err.message}`; }
    }
    function saveSettings() {
      pref = ($('input[name="ai-mode"]:checked') || {}).value || 'auto';
      storage.set('rizal.ai.mode', pref);
      setKey(pref === 'key' ? $('#ai-key').value.trim() : '');
      storage.set('rizal.ai.model', ($('#ai-model').value.trim() || AI_MODEL));
      renderMode();
      dlg.close();
      toast(mode() === 'facts' ? 'Using the fact finder' : 'AI connected');
    }
 
    function init() {
      if (!D) { say('The fact bank (data.js) did not load, so Pluma cannot answer. Check that data.js is next to index.html.'); form.hidden = true; return; }
      say('Hi, I’m Pluma! Ask me anything about José Rizal. I only answer about Rizal, and only from this site’s verified facts, so if I don’t know, I’ll say so.');
      renderSuggestions();
      renderMode();
      detectProxy();
      form.addEventListener('submit', (event) => { event.preventDefault(); const q = input.value; input.value = ''; ask(q); });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
      $('#ask-settings').addEventListener('click', openSettings);
      $('#ai-testbtn').addEventListener('click', testConnection);
      $('#ai-save').addEventListener('click', saveSettings);
      /* “Ask Pluma about this chapter” buttons, added to every chapter header */
      $$('.chapter .ch-actions').forEach((box) => {
        const page = box.closest('.page');
        if (!CHAPTER_IDS.includes(page.id)) return;
        const btn = document.createElement('a');
        btn.className = 'btn btn--ghost'; btn.href = '#ask';
        btn.innerHTML = `${icon('i-send')} Ask Pluma about this`;
        btn.addEventListener('click', () => setContext(page.id));
        box.append(btn);
      });
    }
    return { init, setContext };
  })();
 
 
  /* ------------------------------------------------------------------------
     6e. SCROLL REVEAL: gentle entrance for cards and scenes (skipped when the
     visitor prefers reduced motion).
     ------------------------------------------------------------------------ */
  function initReveal() {
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) return;
    const selector = '.scene, .takeaway, .reflect, .deep > *, .stats li, .work, .value, .stop, .chap-card, .compare-col, .person, .dive, .dyk, .tl-detail, .route, .context, .paper, .desk, .book, .howto-list li, .discover li, .qz-start, .chat, .ask-side';
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        io.unobserve(el);
        el.classList.add('is-in');
        const done = () => { el.classList.remove('reveal', 'is-in'); el.style.removeProperty('--d'); };
        el.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 1400);
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
    $$(selector).forEach((el) => {
      const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.matches(selector)) : [];
      el.style.setProperty('--d', `${Math.min(siblings.indexOf(el), 5) * 0.07}s`);
      el.classList.add('reveal');
      io.observe(el);
    });
  }
 
  /* ------------------------------------------------------------------------
     7. START-UP
     If anything fails, fall back to the no-JavaScript layout so that all
     chapters stay readable.
     ------------------------------------------------------------------------ */
  function init() {
    try {
      Reader.init();
      ReaderUI.init();
      initDialogsCommon();
      Insights.init();
      Lightbox.init();
      initTimeline();
      initTabs();
      initNotes();
      addParagraphButtons();
      Game.init();
      Review.init();
      Ask.init();
      initReveal();
      Router.init();
    } catch (error) {
      console.error('Rizal storybook: falling back to the static layout.', error);
      document.documentElement.classList.remove('js');
      $$('.page').forEach((page) => { page.hidden = false; });
    }
  }
 
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
