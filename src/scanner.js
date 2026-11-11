// Escáner de QR por cámara, compartido por la caja y el panel de admin (sin dependencias de la página).
(function () {
  const CSS = `.fs-ov{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:16px}
.fs-box{width:100%;max-width:460px;background:var(--panel,#141414);color:var(--fg,#fff);border:1px solid rgba(255,255,255,.25);border-radius:20px;padding:18px;display:flex;flex-direction:column;gap:12px;font-family:inherit}
.fs-box h3{margin:0;font-size:18px}.fs-vid{position:relative;border-radius:14px;overflow:hidden;background:#000;aspect-ratio:1/1}
.fs-vid video{width:100%;height:100%;object-fit:cover;display:block}
.fs-frame{position:absolute;inset:18%;border:3px solid #fff;border-radius:18px;box-shadow:0 0 0 999px rgba(0,0,0,.35);pointer-events:none}
.fs-msg{border-radius:12px;padding:12px 14px;font-size:15px;line-height:1.4;background:var(--alt,#222);border:1.5px solid transparent}
.fs-msg b{display:block;font-size:17px;margin-bottom:2px}.fs-ok{border-color:#4ADE80;animation:fspop .35s ease-out}@keyframes fspop{0%{transform:scale(.92);opacity:.4}60%{transform:scale(1.03)}100%{transform:scale(1);opacity:1}}.fs-warn{border-color:#FACC15}.fs-err{border-color:#FF8A80}
.fs-row{display:flex;gap:10px}.fs-row button{flex:1;height:46px;border-radius:12px;border:1px solid var(--fg,#fff);background:transparent;color:var(--fg,#fff);font-weight:700;font-size:15px;cursor:pointer;font-family:inherit;margin:0;width:auto}
.fs-row button.p{background:var(--fg,#fff);color:var(--bg,#000)}`;
  // Sonidos con WebAudio (sin archivos). El contexto se crea al abrir el escáner, que es un toque del usuario.
  let actx;
  function unlockAudio() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { /* sin audio */ }
  }
  function tone(freq, start, dur, vol, type) {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + start;
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function sound(kind) {
    unlockAudio();
    if (kind === 'ok') { tone(988, 0, 0.5, 0.35); tone(1319, 0.11, 0.7, 0.3); }                 // ding
    else if (kind === 'win') { [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.1, 0.6, 0.3)); } // premio
    else if (kind === 'warn') { tone(660, 0, 0.18, 0.25, 'triangle'); tone(660, 0.22, 0.18, 0.25, 'triangle'); }
    else { tone(196, 0, 0.35, 0.3, 'square'); }
    try { if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : kind === 'win' ? [60, 50, 60, 50, 120] : [120, 60, 120]); } catch (e) { /* sin vibración */ }
  }
  let jsqrP;
  const loadJsqr = () => window.jsQR ? Promise.resolve() : (jsqrP = jsqrP || new Promise((ok, ko) => {
    const s = document.createElement('script'); s.src = '/vendor/jsqr.js'; s.onload = ok;
    s.onerror = () => ko(new Error('No se pudo cargar el lector de QR.')); document.head.appendChild(s);
  }));

  async function call(cfg, path, code) {
    const res = await fetch('/api/' + cfg.slug + '/' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...cfg.headers() }, body: JSON.stringify({ code }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || 'No se pudo completar la acción.');
    return j;
  }
  function describe(r) {
    const c = r.customer || {}; const n = c.name || 'Cliente';
    if (r.status === 'visit') return { kind: 'ok', title: 'Visita registrada', text: n + ': ' + c.visits + ' de ' + c.required + (r.rewardUnlocked ? '. ¡Ya tiene su premio!' : ''), redeem: !!r.rewardUnlocked, name: n };
    if (r.status === 'too_soon') return { kind: 'warn', title: 'Ya sumó una visita hace poco', text: n + ' podrá sumar otra desde ' + new Date(r.nextAllowedAt).toLocaleString('es-DO') + '.', name: n };
    if (r.status === 'free_available') return { kind: 'warn', title: 'Premio disponible', text: n + ' ya completó sus visitas. ¿Canjear ahora?', redeem: true, name: n };
    return { kind: 'ok', title: 'Listo', text: n, name: n };
  }

  function open(cfg) {
    if (document.querySelector('.fs-ov')) return;
    unlockAudio();
    if (!document.getElementById('fs-css')) { const st = document.createElement('style'); st.id = 'fs-css'; st.textContent = CSS; document.head.appendChild(st); }
    const ov = document.createElement('div'); ov.className = 'fs-ov';
    ov.innerHTML = '<div class="fs-box"><h3>Escanear QR del cliente</h3><div class="fs-vid"><video playsinline muted></video><div class="fs-frame"></div></div><div class="fs-msg" id="fs-m">Apunta la cámara al QR de la tarjeta en el celular del cliente.</div><div class="fs-row" id="fs-a"></div><div class="fs-row"><button id="fs-x">Cerrar</button></div></div>';
    document.body.appendChild(ov);
    const video = ov.querySelector('video'), msg = ov.querySelector('#fs-m'), acts = ov.querySelector('#fs-a');
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream, timer, paused = false, closed = false, last = '', lastAt = 0, resumeT;
    const setMsg = (kind, title, text) => { msg.className = 'fs-msg' + (kind ? ' fs-' + kind : ''); msg.innerHTML = ''; const b = document.createElement('b'); b.textContent = title; msg.appendChild(b); msg.appendChild(document.createTextNode(text || '')); };
    const clearActs = () => { acts.innerHTML = ''; };
    const resume = (ms) => { clearTimeout(resumeT); resumeT = setTimeout(() => { if (closed) return; clearActs(); setMsg('', 'Listo para escanear', 'Apunta al siguiente QR.'); paused = false; }, ms); };
    const close = () => { closed = true; clearTimeout(timer); clearTimeout(resumeT); if (stream) stream.getTracks().forEach((t) => t.stop()); ov.remove(); };
    ov.querySelector('#fs-x').onclick = close;
    const btn = (label, primary, fn) => { const b = document.createElement('button'); b.textContent = label; if (primary) b.className = 'p'; b.onclick = fn; acts.appendChild(b); };

    async function handle(data) {
      paused = true; last = data; lastAt = Date.now(); clearActs();
      if (!data.startsWith(cfg.slug + '.')) { sound('err'); setMsg('err', 'QR no válido', 'Ese código no es de esta tarjeta.'); return resume(2500); }
      try {
        const r = await call(cfg, 'scan', data); const d = describe(r);
        sound(d.redeem && d.kind === 'ok' ? 'win' : d.kind); setMsg(d.kind, d.title, d.text); if (cfg.onChange) cfg.onChange();
        if (d.redeem) {
          btn('Canjear premio', true, async () => {
            clearActs();
            try { await call(cfg, 'redeem', data); sound('win'); setMsg('ok', 'Premio canjeado', d.name + ': su tarjeta vuelve a 0.'); if (cfg.onChange) cfg.onChange(); }
            catch (e) { sound('err'); setMsg('err', 'No se pudo canjear', e.message); }
            resume(2800);
          });
          btn('Ahora no', false, () => { clearActs(); resume(0); });
        } else resume(2800);
      } catch (e) { sound('err'); setMsg('err', 'No se pudo registrar', e.message); resume(3000); }
    }
    function tick() {
      if (closed) return; timer = setTimeout(tick, 150);
      if (paused || video.readyState < 2 || !video.videoWidth) return;
      const sc = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * sc); canvas.height = Math.round(video.videoHeight * sc);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const q = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (q && q.data && !(q.data === last && Date.now() - lastAt < 5000)) handle(q.data.trim());
    }
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este navegador no permite usar la cámara.');
        await loadJsqr();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (closed) return stream.getTracks().forEach((t) => t.stop());
        video.srcObject = stream; await video.play(); tick();
      } catch (e) {
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        setMsg('err', 'No se pudo abrir la cámara', denied ? 'Permite el acceso a la cámara en tu navegador y vuelve a intentar.' : e.message);
      }
    })();
  }
  window.FirmelyScan = { open, call, describe };
})();
