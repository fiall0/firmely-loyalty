const { mix } = require('./stamps');
// Páginas mínimas servidas por el propio backend: registro del cliente y caja (prueba manual).
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STYLE = (brand) => `
:root{--bg:${brand.bg};--fg:${brand.fg};--panel:${mix(brand.bg, brand.fg, 0.1)};--line:${mix(brand.bg, brand.fg, 0.25)};--muted:${mix(brand.bg, brand.fg, 0.7)};--alt:${mix(brand.bg, brand.fg, 0.16)}}
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px -apple-system,system-ui,sans-serif;padding:24px 16px;display:flex;justify-content:center}
main{width:100%;max-width:420px}h1{font-size:24px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px}
p.sub{color:var(--muted);margin:0 0 24px}label{display:block;font-size:13px;color:var(--muted);margin:16px 0 6px}
input[type=text],input[type=tel],input[type=password]{width:100%;padding:14px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font-size:17px}
.check{display:flex;gap:10px;align-items:flex-start;margin:18px 0;color:var(--muted);font-size:14px}.check input{margin-top:3px;width:20px;height:20px}
button,a.btn{display:block;width:100%;text-align:center;padding:15px;border-radius:12px;border:0;background:var(--fg);color:var(--bg);font-size:17px;font-weight:600;text-decoration:none;margin-top:12px}
button.alt{background:var(--alt);color:var(--fg)}.err{color:#ff6b6b;margin-top:12px;min-height:20px}
header.hero{text-align:center;margin:8px 0 28px}
.hero .logo{width:150px;height:150px;margin:0 auto 22px;border-radius:50%;overflow:hidden;border:3px solid var(--fg);background:var(--bg)}
.hero .logo img{display:block;width:100%;height:100%;object-fit:cover}
.hero h1{font-size:26px;letter-spacing:.06em;margin:0 0 8px;font-weight:800}
.hero p.sub{font-size:18px;color:var(--fg);margin:0}
pre{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:13px}`;

function shell(title, body, script, slug, brand) {
  const icon = slug ? `<link rel="icon" type="image/png" href="/api/${esc(slug)}/logo.png"><link rel="apple-touch-icon" href="/api/${esc(slug)}/logo.png">` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${icon}
<title>${esc(title)}</title><style>${STYLE(brand)}</style></head><body><main>${body}</main><script>${script}</script></body></html>`;
}

function registro(b, on, brand) {
  const body = `<header class="hero">
<div class="logo"><img src="/api/${esc(b.slug)}/logo.png" alt="Logo de ${esc(b.name)}" onerror="this.parentNode.hidden=true"></div>
<h1>Tarjeta de fidelidad</h1>
<p class="sub">${b.visits_required} visitas = ${esc(b.reward.toLowerCase())}</p>
</header>
<form id="f"><label>Nombre</label><input id="n" type="text" autocomplete="name" required>
<label>Teléfono</label><input id="p" type="tel" autocomplete="tel" inputmode="tel" required>
<div class="check"><input id="c" type="checkbox"><span>Acepto que ${esc(b.name)} guarde mi nombre y teléfono para la tarjeta de fidelidad y me envíe avisos.</span></div>
<button type="submit">Crear mi tarjeta</button><div class="err" id="e"></div></form>
<div id="ok" hidden><p class="sub" style="text-align:center">¡Listo! Agrega tu tarjeta al teléfono:</p>
${on.apple ? '<a class="btn" id="apple" hidden>Agregar a Apple Wallet</a>' : ''}
${on.google ? '<a class="btn" id="google" hidden>Agregar a Google Wallet</a>' : ''}
${on.apple || on.google ? '' : '<p class="sub" style="text-align:center">La billetera digital no está disponible todavía.</p>'}
<p class="sub" style="margin-top:28px;text-align:center">Tu código (para la prueba en caja):</p><pre id="code"></pre>
<a class="btn" id="caja" style="background:var(--alt);color:var(--fg)">Abrir caja con este código</a></div>`;
  const script = `
const slug=${JSON.stringify(b.slug)};
document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const e=document.getElementById('e');e.textContent='';
const r=await fetch('/api/'+slug+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.getElementById('n').value,phone:document.getElementById('p').value,consent:document.getElementById('c').checked})});
const j=await r.json();if(!r.ok){e.textContent=j.message||'Error';return}
document.getElementById('f').hidden=true;document.querySelector('.hero p.sub').hidden=false;document.getElementById('ok').hidden=false;
document.getElementById('code').textContent=j.code;document.getElementById('caja').href='/caja/'+slug+'?code='+encodeURIComponent(j.code);
const ua=navigator.userAgent,ios=/iPhone|iPad|iPod/.test(ua)||(/Mac/.test(ua)&&navigator.maxTouchPoints>1),android=/Android/.test(ua);
const a=document.getElementById('apple'),g=document.getElementById('google');
if(a){a.href='/api/'+slug+'/pass.pkpass?code='+encodeURIComponent(j.code);a.hidden=android&&!!g}
if(g){g.href='/api/'+slug+'/google-wallet?code='+encodeURIComponent(j.code);g.hidden=ios&&!!a}});`;
  return shell(`${b.name} · Tarjeta`, body, script, b.slug, brand);
}

function caja(b, brand) {
  const body = `<h1>${esc(b.name)} · Caja</h1><p class="sub">Escanea el QR de la tarjeta del cliente para sumar su visita.</p>
<label>Llave de caja</label><input id="k" type="password" autocomplete="off">
<button id="scan">Escanear QR</button><div class="err" id="e"></div>
<details style="margin-top:28px;color:var(--muted)"><summary style="cursor:pointer">Ingresar el código a mano</summary>
<label>Código del cliente</label><input id="c" type="text" autocomplete="off" autocapitalize="off">
<button class="alt" id="s">Sumar visita</button><button class="alt" id="r">Canjear premio</button><pre id="o" hidden></pre></details>
<script src="/vendor/scanner.js"></script>`;
  const script = `
const slug=${JSON.stringify(b.slug)};const $=(i)=>document.getElementById(i);
$('k').value=sessionStorage.getItem('k')||'';$('c').value=new URLSearchParams(location.search).get('code')||'';
const cfg={slug,headers:()=>({'x-api-key':$('k').value,'x-actor':'caja'})};
$('scan').onclick=()=>{$('e').textContent='';if(!$('k').value){$('e').textContent='Escribe la llave de caja.';return}sessionStorage.setItem('k',$('k').value);FirmelyScan.open(cfg)};
async function go(path){sessionStorage.setItem('k',$('k').value);$('e').textContent='';$('o').hidden=false;
try{const r=await FirmelyScan.call(cfg,path,$('c').value.trim());const d=FirmelyScan.describe(r);$('o').textContent=path==='redeem'?'Premio canjeado. '+d.text:d.title+'. '+d.text}catch(e){$('o').textContent=e.message}}
$('s').onclick=()=>go('scan');$('r').onclick=()=>go('redeem');`;
  return shell(`${b.name} · Caja`, body, script, b.slug, brand);
}

const fs = require('fs');
const path = require('path');
const adminTpl = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const admin = (b, brand) => adminTpl
  .replace(':root{color-scheme:dark}', `:root{color-scheme:dark;--bg:${brand.bg};--fg:${brand.fg};--fgrgb:${[1, 3, 5].map((i) => parseInt(brand.fg.slice(i, i + 2), 16)).join(',')};--panel:${mix(brand.bg, brand.fg, 0.1)};--alt:${mix(brand.bg, brand.fg, 0.2)};--muted:${mix(brand.bg, brand.fg, 0.7)}}`)
  .replace(/__NAME__/g, esc(b.name)).replace(/__SLUG__/g, esc(b.slug));

module.exports = { registro, caja, admin };
