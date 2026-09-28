/* ISP Watchdog: browser speed test + ISP accountability.
 * No dependencies, no tracking. Results are kept in localStorage on this device only. */
(() => {
  'use strict';

  // ---------- test servers ----------
  const SERVERS = {
    cloudflare: {
      name: 'Cloudflare',
      down: (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
      up: 'https://speed.cloudflare.com/__up',
      meta: 'https://speed.cloudflare.com/meta',
      maxDown: 50e6,
      maxUp: 25e6,
    },
    edge: {
      name: 'Vercel Edge',
      down: (bytes) => `/api/down?bytes=${bytes}`,
      up: '/api/up',
      meta: '/api/meta',
      maxDown: 25e6,
      maxUp: 3.5e6,
    },
  };

  const PHASE_MS = 8000;       // length of each throughput phase
  const STREAMS = 4;           // parallel connections
  const PING_COUNT = 20;
  const STORE_KEY = 'ispwatchdog.v1';

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nocache = () => `&r=${Math.random().toString(36).slice(2)}`;
  const mbps = (bytes, ms) => (ms > 0 ? (bytes * 8) / ms / 1000 : 0);
  const fmt = (n) => (n == null || !isFinite(n) ? '–' : n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function withTimeout(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, done: () => clearTimeout(t) };
  }

  const store = {
    read() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
    },
    write(data) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* private mode: keep going */ }
    },
  };

  // ---------- gauge ----------
  const GAUGE_STOPS = [0, 5, 10, 25, 50, 100, 250, 500, 1000];
  const gaugeFill = $('gauge-fill');

  function gaugePct(v) {
    if (v <= 0) return 0;
    for (let i = 1; i < GAUGE_STOPS.length; i++) {
      if (v <= GAUGE_STOPS[i]) {
        const lo = GAUGE_STOPS[i - 1], hi = GAUGE_STOPS[i];
        return ((i - 1) + (v - lo) / (hi - lo)) / (GAUGE_STOPS.length - 1) * 100;
      }
    }
    return 100;
  }

  function drawTicks() {
    const g = $('gauge-ticks');
    const ns = 'http://www.w3.org/2000/svg';
    const cx = 150, cy = 150;
    GAUGE_STOPS.forEach((v, i) => {
      const a = (135 + (270 * i) / (GAUGE_STOPS.length - 1)) * Math.PI / 180;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', cx + 104 * Math.cos(a));
      line.setAttribute('y1', cy + 104 * Math.sin(a));
      line.setAttribute('x2', cx + 110 * Math.cos(a));
      line.setAttribute('y2', cy + 110 * Math.sin(a));
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', cx + 88 * Math.cos(a));
      text.setAttribute('y', cy + 88 * Math.sin(a) + 4);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = v >= 1000 ? '1G' : v;
      g.append(line, text);
    });
  }

  function setGauge(value, kind = 'down') {
    gaugeFill.style.strokeDasharray = `${gaugePct(value)} 200`;
    gaugeFill.classList.toggle('on', value > 0);
    gaugeFill.classList.toggle('up', kind === 'up');
    $('live-value').textContent = value > 0 ? fmt(value) : '0';
    $('live-unit').textContent = 'Mbps';
  }

  function setPhase(label, progress = 0) {
    $('phase').textContent = label;
    $('phase-bar').style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
  }

  // ---------- measurements ----------
  async function pickServer() {
    const t = withTimeout(4000);
    try {
      const res = await fetch(SERVERS.cloudflare.down(0) + nocache(), { cache: 'no-store', signal: t.signal });
      if (res.ok) { await res.arrayBuffer(); return SERVERS.cloudflare; }
    } catch { /* fall through */ } finally { t.done(); }
    return SERVERS.edge;
  }

  async function loadMeta(server) {
    const t = withTimeout(4000);
    try {
      const res = await fetch(server.meta, { cache: 'no-store', signal: t.signal });
      if (res.ok) return await res.json();
    } catch { /* optional */ } finally { t.done(); }
    return null;
  }

  async function measureLatency(server, onProgress) {
    const times = [];
    for (let i = 0; i < PING_COUNT + 1; i++) {
      const t0 = now();
      const res = await fetch(server.down(0) + nocache(), { cache: 'no-store' });
      await res.arrayBuffer();
      const dt = now() - t0;
      if (i > 0) times.push(dt); // first request pays for connection setup
      onProgress((i + 1) / (PING_COUNT + 1), dt);
    }
    const tail = times.slice(-Math.max(5, times.length - 2));
    let jitter = 0;
    for (let i = 1; i < tail.length; i++) jitter += Math.abs(tail[i] - tail[i - 1]);
    jitter /= Math.max(1, tail.length - 1);
    return { ping: median(tail), jitter };
  }

  /** Runs `worker` in several parallel streams for PHASE_MS and returns the steady-state speed. */
  async function measureThroughput(worker, onProgress) {
    const ctrl = new AbortController();
    const counter = { bytes: 0 };
    const samples = [];
    const start = now();
    const deadline = start + PHASE_MS;

    const tick = setInterval(() => {
      const t = now();
      samples.push({ t, bytes: counter.bytes });
      // live speed over the last ~3 s (smooths out bursty upload completions)
      const ref = samples.find((s) => s.t >= t - 3000) || samples[0];
      const live = mbps(counter.bytes - ref.bytes, t - ref.t);
      onProgress(Math.min(1, (t - start) / PHASE_MS), live || mbps(counter.bytes, t - start));
    }, 150);
    const stop = setTimeout(() => ctrl.abort(), PHASE_MS);

    const results = await Promise.allSettled(
      Array.from({ length: STREAMS }, (_, i) => worker({ counter, signal: ctrl.signal, deadline, stream: i })),
    );
    clearInterval(tick);
    clearTimeout(stop);
    const end = now();
    samples.push({ t: end, bytes: counter.bytes });

    if (counter.bytes === 0) {
      const reason = results.find((r) => r.status === 'rejected');
      throw new Error(reason ? reason.reason.message || 'network error' : 'no data transferred');
    }
    // Ignore the first 25% (TCP ramp-up) when the sample is large enough.
    const warm = samples.find((s) => s.t >= start + PHASE_MS * 0.25);
    if (warm && end - warm.t > 1000 && counter.bytes - warm.bytes > 0) {
      return mbps(counter.bytes - warm.bytes, end - warm.t);
    }
    return mbps(counter.bytes, end - start);
  }

  function downloadWorker(server) {
    return async ({ counter, signal, deadline }) => {
      let size = 250e3;
      while (now() < deadline && !signal.aborted) {
        const t0 = now();
        let got = 0;
        try {
          const res = await fetch(server.down(Math.round(size)) + nocache(), { cache: 'no-store', signal });
          if (!res.ok) throw new Error(`download server replied ${res.status}`);
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            counter.bytes += value.length;
            got += value.length;
          }
        } catch (e) {
          if (signal.aborted) return;
          throw e;
        }
        // aim for requests of ~1.5 s each
        const took = Math.max(1, now() - t0);
        size = Math.min(server.maxDown, Math.max(100e3, (got / took) * 1500));
      }
    };
  }

  function makePayload(bytes) {
    const block = new Uint8Array(65536);
    crypto.getRandomValues(block);
    const parts = [];
    for (let n = 0; n < bytes; n += block.length) parts.push(block);
    return new Blob(parts).slice(0, bytes); // no content type → simple CORS request, no preflight
  }

  function uploadWorker(server) {
    const payload = makePayload(server.maxUp);
    return async ({ counter, signal, deadline }) => {
      let size = 100e3;
      while (now() < deadline && !signal.aborted) {
        const t0 = now();
        try {
          const res = await fetch(server.up, { method: 'POST', body: payload.slice(0, Math.round(size)), cache: 'no-store', signal });
          if (!res.ok) throw new Error(`upload server replied ${res.status}`);
          await res.arrayBuffer();
        } catch (e) {
          if (signal.aborted) return;
          throw e;
        }
        counter.bytes += Math.round(size);
        const took = Math.max(1, now() - t0);
        size = Math.min(server.maxUp, Math.max(50e3, (size / took) * 1000));
      }
    };
  }

  // ---------- plan / verdict ----------
  const els = {
    down: $('promised-down'), up: $('promised-up'), handle: $('isp-handle'), tol: $('tolerance'),
    complaint: $('complaint'), postX: $('post-x'),
  };

  function readPlan() {
    const handle = els.handle.value.trim().replace(/[^\w@]/g, '');
    return {
      down: Math.max(0.1, parseFloat(els.down.value) || 50),
      up: Math.max(0.1, parseFloat(els.up.value) || 10),
      handle: handle ? (handle.startsWith('@') ? handle : '@' + handle) : '',
      tolerance: (parseInt(els.tol.value, 10) || 80) / 100,
    };
  }

  function savePlan() {
    const data = store.read();
    data.plan = { down: els.down.value, up: els.up.value, handle: els.handle.value, tol: els.tol.value };
    store.write(data);
    $('tol-out').textContent = `${els.tol.value}%`;
    if (lastResult) renderVerdict(lastResult);
    renderHistory();
  }

  function loadPlan() {
    const { plan } = store.read();
    if (plan) {
      els.down.value = plan.down ?? els.down.value;
      els.up.value = plan.up ?? els.up.value;
      els.handle.value = plan.handle ?? '';
      els.tol.value = plan.tol ?? els.tol.value;
    }
    $('tol-out').textContent = `${els.tol.value}%`;
  }

  const isBelow = (r, plan) => r.down < plan.down * plan.tolerance || r.up < plan.up * plan.tolerance;

  function complaintText(r, plan) {
    const who = plan.handle || 'my internet provider';
    const site = location.host || 'ISP Watchdog';
    return `Hey ${who}, why is my internet speed ${fmt(r.down)} Mbps down / ${fmt(r.up)} Mbps up ` +
      `(ping ${Math.round(r.ping)} ms) when I pay for ${plan.down} down / ${plan.up} up? Tested on ${site}`;
  }

  function updatePostLink() {
    const text = els.complaint.value;
    $('count').textContent = text.length;
    els.postX.href = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
  }

  function renderPct(r, plan) {
    const d = r.down / plan.down, u = r.up / plan.up;
    const tag = (el, pct) => {
      el.textContent = `${Math.round(pct * 100)}% of plan`;
      el.className = 'sub ' + (pct < plan.tolerance ? 'bad' : 'good');
    };
    tag($('s-down-pct'), d);
    tag($('s-up-pct'), u);
    return { d, u };
  }

  function renderVerdict(r) {
    const plan = readPlan();
    const { d, u } = renderPct(r, plan);
    const below = isBelow(r, plan);
    const badge = $('v-badge');
    badge.textContent = below ? 'Below plan' : 'On track';
    badge.className = 'badge ' + (below ? 'bad' : 'good');
    $('v-title').textContent = below
      ? `You're getting ${Math.round(Math.min(d, u) * 100)}% of what you pay for.`
      : 'Your provider is delivering what you pay for.';
    const bar = (id, pct) => { $(id).style.width = `${Math.min(100, pct * 100)}%`; };
    bar('b-down', d); bar('b-up', u);
    $('m-down').style.left = $('m-up').style.left = `${plan.tolerance * 100}%`;
    $('p-down').textContent = `${Math.round(d * 100)}%`;
    $('p-up').textContent = `${Math.round(u * 100)}%`;
    if (!els.complaint.dataset.edited) els.complaint.value = complaintText(r, plan);
    els.postX.textContent = below ? 'Post on X' : 'Share on X';
    updatePostLink();
    $('verdict').hidden = false;
  }

  // ---------- history ----------
  function history() { return store.read().history || []; }

  function addHistory(r) {
    const data = store.read();
    data.history = [r, ...(data.history || [])].slice(0, 100);
    store.write(data);
  }

  function renderHistory() {
    const rows = history();
    const plan = readPlan();
    const body = $('hist-body');
    body.replaceChildren();
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty';
      tr.innerHTML = '<td colspan="5">Run a test to start your history.</td>';
      body.append(tr);
    }
    for (const r of rows.slice(0, 30)) {
      const tr = document.createElement('tr');
      const when = new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const below = isBelow(r, plan);
      for (const text of [when, fmt(r.down), fmt(r.up), `${Math.round(r.ping)} ms`]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      const td = document.createElement('td');
      const flag = document.createElement('span');
      flag.className = 'flag ' + (below ? 'bad' : 'good');
      flag.textContent = below ? 'Below' : 'OK';
      td.append(flag);
      tr.append(td);
      body.append(tr);
    }
    drawSpark(rows.slice(0, 20).reverse(), plan);
  }

  function drawSpark(rows, plan) {
    const svg = $('spark');
    const ns = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    const W = 320, H = 90, P = 8;
    if (rows.length < 2) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', W / 2); t.setAttribute('y', H / 2); t.setAttribute('text-anchor', 'middle');
      t.textContent = rows.length ? 'Run one more test to see your trend' : 'Your download trend will appear here';
      svg.append(t);
      return;
    }
    const max = Math.max(plan.down, ...rows.map((r) => r.down)) * 1.1;
    const x = (i) => P + (i * (W - 2 * P)) / (rows.length - 1);
    const y = (v) => H - P - (v / max) * (H - 2 * P);
    const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.down).toFixed(1)}`);
    const mk = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); return e; };
    mk('path', { class: 'area', d: `M${x(0)},${H - P} L${pts.join(' L')} L${x(rows.length - 1)},${H - P} Z` });
    mk('line', { class: 'plan', x1: P, x2: W - P, y1: y(plan.down), y2: y(plan.down) });
    mk('path', { class: 'line', d: `M${pts.join(' L')}` });
    rows.forEach((r, i) => mk('circle', { class: 'dot' + (isBelow(r, plan) ? ' bad' : ''), cx: x(i), cy: y(r.down), r: 2.6 }));
    const label = mk('text', { x: W - P, y: Math.max(10, y(plan.down) - 4), 'text-anchor': 'end' });
    label.textContent = `plan ${plan.down} Mbps`;
  }

  function exportCsv() {
    const rows = history();
    if (!rows.length) return;
    const plan = readPlan();
    const lines = [['tested_at', 'download_mbps', 'upload_mbps', 'ping_ms', 'jitter_ms', 'server', 'below_plan']];
    for (const r of rows) lines.push([r.at, r.down.toFixed(2), r.up.toFixed(2), r.ping.toFixed(1), r.jitter.toFixed(1), r.server, isBelow(r, plan)]);
    const blob = new Blob([lines.map((l) => l.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `isp-watchdog-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- run ----------
  let running = false;
  let lastResult = null;
  const goBtn = $('go');

  function setButton(state) {
    goBtn.setAttribute('aria-busy', String(state === 'busy'));
    goBtn.disabled = state === 'busy';
    goBtn.querySelector('.go-label').textContent = state === 'busy' ? 'Testing…' : state === 'again' ? 'Test again' : 'Start test';
  }

  function showError(msg) {
    const el = $('error');
    el.textContent = msg;
    el.hidden = !msg;
  }

  async function run() {
    if (running) return;
    running = true;
    showError('');
    setButton('busy');
    ['s-ping', 's-jitter', 's-down', 's-up'].forEach((id) => { $(id).textContent = '–'; });
    ['s-down-pct', 's-up-pct'].forEach((id) => { $(id).textContent = ' '; $(id).className = 'sub'; });
    setGauge(0);

    try {
      setPhase('Connecting', 0);
      const server = await pickServer();
      loadMeta(server).then(showMeta);

      setPhase('Ping', 0);
      $('live-unit').textContent = 'ms';
      const lat = await measureLatency(server, (p, dt) => {
        setPhase('Ping', p);
        $('live-value').textContent = Math.round(dt);
        $('live-unit').textContent = 'ms';
      });
      $('s-ping').textContent = Math.round(lat.ping);
      $('s-jitter').textContent = lat.jitter.toFixed(1);

      setPhase('Download', 0);
      const down = await measureThroughput(downloadWorker(server), (p, v) => {
        setPhase('Download', p);
        setGauge(v, 'down');
        $('s-down').textContent = fmt(v);
      });
      $('s-down').textContent = fmt(down);
      setGauge(down, 'down');
      await sleep(400);

      setGauge(0, 'up');
      setPhase('Upload', 0);
      const up = await measureThroughput(uploadWorker(server), (p, v) => {
        setPhase('Upload', p);
        setGauge(v, 'up');
        $('s-up').textContent = fmt(v);
      });
      $('s-up').textContent = fmt(up);
      setGauge(down, 'down');
      setPhase('Done · download', 1);

      lastResult = { at: new Date().toISOString(), down, up, ping: lat.ping, jitter: lat.jitter, server: server.name };
      addHistory(lastResult);
      delete els.complaint.dataset.edited;
      renderVerdict(lastResult);
      renderHistory();
      setButton('again');
    } catch (e) {
      console.error(e);
      setPhase('Failed', 0);
      setGauge(0);
      showError(`The test couldn't finish: ${e.message}. Check your connection or disable ad blockers for this page, then try again.`);
      setButton('again');
    } finally {
      running = false;
    }
  }

  function showMeta(meta) {
    const conn = $('conn');
    if (!meta) { conn.textContent = 'Your IP address is never stored.'; return; }
    const where = [meta.city, meta.country].filter(Boolean).join(', ');
    const parts = [];
    if (meta.asOrganization) parts.push(`Network: ${meta.asOrganization}`);
    if (where) parts.push(`Location: ${where}`);
    const colo = meta.colo && typeof meta.colo === 'object'
      ? [meta.colo.city, meta.colo.iata && `(${meta.colo.iata})`].filter(Boolean).join(' ')
      : meta.colo;
    if (colo) parts.push(`Test server: ${colo}`);
    conn.textContent = parts.join('  ·  ') || 'Connected';
  }

  // ---------- wire up ----------
  drawTicks();
  loadPlan();
  renderHistory();
  loadMeta(SERVERS.cloudflare).then((m) => (m ? showMeta(m) : loadMeta(SERVERS.edge).then(showMeta)));

  goBtn.addEventListener('click', run);
  $('plan-form').addEventListener('input', savePlan);
  $('plan-form').addEventListener('submit', (e) => e.preventDefault());
  els.complaint.addEventListener('input', () => { els.complaint.dataset.edited = '1'; updatePostLink(); });

  $('copy').addEventListener('click', async () => {
    const btn = $('copy');
    try {
      await navigator.clipboard.writeText(els.complaint.value);
      btn.textContent = 'Copied';
    } catch {
      els.complaint.select();
      btn.textContent = 'Select & copy';
    }
    setTimeout(() => { btn.textContent = 'Copy text'; }, 1600);
  });

  if (navigator.share) {
    const share = $('share');
    share.hidden = false;
    share.addEventListener('click', () => navigator.share({ text: els.complaint.value }).catch(() => {}));
  }

  $('export').addEventListener('click', exportCsv);
  $('clear').addEventListener('click', () => { $('confirm-clear').hidden = !history().length; });
  $('clear-no').addEventListener('click', () => { $('confirm-clear').hidden = true; });
  $('clear-yes').addEventListener('click', () => {
    const data = store.read();
    delete data.history;
    store.write(data);
    $('confirm-clear').hidden = true;
    renderHistory();
  });
})();
