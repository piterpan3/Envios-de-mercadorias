'use strict';
/* BENGA ENVIOS — servidor (sem dependências externas, Node 18+).
   Serve o site (public/index.html) e a API (/api/*). Dados em data/benga.json (com cópia diária). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

/* lê o ficheiro .env (se existir) sem precisar de bibliotecas; variáveis já definidas no ambiente têm prioridade */
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); }); } catch { }
const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'benga.json');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const SESSION_MS = 7 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const plusMinutes = mins => new Date(Date.now() + mins * 60000).toISOString();

/* ---------- segurança: palavras-passe e sessões ---------- */
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return 'scrypt$' + salt + '$' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const DUMMY = hashPw('x-dummy-password');
const checkPw = (pw, h) => { try { const [, salt, hex] = String(h || DUMMY).split('$'); const a = crypto.scryptSync(String(pw), salt, 64), b = Buffer.from(hex, 'hex'); return !!h && a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- base de dados (ficheiro JSON, escrita atómica) ---------- */
const defaults = () => ({
  nid: 1, seqs: {}, users: [], orders: [], ev: [], notif: [], addr: [], log: [], rev: [], support: [], sessions: {},
  cargo: ['Roupa', 'Calçado', 'Eletrónica', 'Documentos', 'Alimentos', 'Produtos diversos', 'Outros'].map((name, i) => ({ id: 1000 + i, name })),
  S: {
    company: 'BENGA ENVIOS', slogan: 'O seu mundo, sem limites.', nif: '', hours: '', phone: '', email: '', whatsapp: '',
    price_per_kg: 12.5, lu_min: 4000, lu_max: 15000, out_min: 20000, out_max: 30000,
    addr_ao: 'Ex-combatentes, Prédio 236, 3.º andar.', addr_pt: 'Rua Pires Antunes n.º 11, Queluz Belas, 2745-327, R/C A',
    stat_envios: 0, stat_kg: 0, stat_clientes: 0,
    pay_info: 'Transferência bancária — titular: Rachid Gomes\nConta Portugal (IBAN): PT50 0193 0000 10507750890 11\nConta Angola (NIB): 0040.0000.5256.1892.1014.3', pay_methods: 'Transferência bancária',
    states: 'Recebida,Em preparação,No armazém,Em trânsito,Chegou ao destino,Em entrega,Entregue,Cancelada',
    notif_approve: 'sim', notif_refuse: 'sim', notif_payment: 'sim', notif_status: 'sim',
    zones: [{ name: 'Luanda (município)', province: 'Luanda', min: 4000, max: 15000 }, { name: 'Fora de Luanda', province: 'Outras províncias', min: 20000, max: 30000 }]
  }
});
let D;
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const d = defaults();
  if (fs.existsSync(DB_FILE)) { D = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); for (const k of Object.keys(d)) if (!(k in D)) D[k] = d[k]; for (const k of Object.keys(d.S)) if (!(k in D.S)) D.S[k] = d.S[k]; }
  else D = d;
}
function save() {
  const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(D)); fs.renameSync(tmp, DB_FILE);
  try {
    const dir = path.join(DATA_DIR, 'backups'), f = path.join(dir, 'benga-' + new Date().toISOString().slice(0, 10) + '.json');
    if (!fs.existsSync(f)) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(DB_FILE, f); fs.readdirSync(dir).sort().slice(0, -30).forEach(x => fs.unlinkSync(path.join(dir, x))); }
  } catch (e) { console.error('Aviso: falha na cópia de segurança:', e.message); }
}
function seedAdmin() {
  if (D.users.some(u => u.role === 'admin')) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (!EMAIL_RE.test(email) || pw.length < 10) { console.error('\nPrimeira execução: defina ADMIN_EMAIL e ADMIN_PASSWORD (mín. 10 caracteres) para criar a conta de administrador.\n'); process.exit(1); }
  D.users.push({ id: D.nid++, name: process.env.ADMIN_NAME || 'Administrador BENGA', email, phone: '', role: 'admin', pw: hashPw(pw), created_at: now() });
  if (!D.S.email) D.S.email = email;
  save(); console.log('Conta de administrador criada: ' + email);
}

/* ---------- utilitários ---------- */
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const E = (m, s = 400) => { throw new HttpError(s, m); };
const T = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const ipOf = req => TRUST_PROXY ? (String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress) : req.socket.remoteAddress;
const isSecure = req => !!req.socket.encrypted || process.env.FORCE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const hits = new Map(), fails = new Map();
const limited = (key, max, win) => { const t = Date.now(), a = (hits.get(key) || []).filter(x => t - x < win); if (a.length >= max) { hits.set(key, a); return true; } a.push(t); hits.set(key, a); return false; };
const failCount = (key, win = 15 * 60e3) => { const t = Date.now(), a = (fails.get(key) || []).filter(x => t - x < win); fails.set(key, a); return a.length; };
const addFail = key => { const a = fails.get(key) || []; a.push(Date.now()); fails.set(key, a); };
setInterval(() => { const t = Date.now(); for (const [k, a] of hits) if (!a.some(x => t - x < 3600e3)) hits.delete(k); for (const [k, a] of fails) if (!a.some(x => t - x < 900e3)) fails.delete(k); }, 600e3).unref();

const pubUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, photo: u.photo || null, prefs: u.prefs || 'sim', blocked: !!u.blocked, created_at: u.created_at, has_password: !!u.pw, provider: u.provider || null });
const note = (uid, text) => { D.notif.push({ user_id: uid, text, created_at: now() }); if (D.notif.length > 5000) D.notif = D.notif.slice(-4000); };
const noteStaff = text => D.users.filter(u => u.role !== 'client' && !u.blocked).forEach(u => note(u.id, text));
const logA = (u, action, detail) => { D.log.push({ user_id: u ? u.id : null, name: u ? u.name : 'Sistema', action, detail: T(detail, 300), created_at: now() }); if (D.log.length > 3000) D.log = D.log.slice(-2500); };
const evAdd = (o, status, n) => D.ev.push({ order_id: o.id, status, note: n || null, created_at: now() });
const killSessions = (uid, except) => { for (const [k, s] of Object.entries(D.sessions)) if (s.uid === uid && k !== except) delete D.sessions[k]; };

function cookiesOf(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) { try { o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch { } } }); return o; }
function sessionOf(req) {
  const t = cookiesOf(req).benga_sid; if (!t) return {};
  const key = sha(t), s = D.sessions[key]; if (!s) return {};
  if (s.exp < Date.now()) { delete D.sessions[key]; return {}; }
  const u = D.users.find(x => x.id === s.uid); if (!u || u.blocked) return {};
  return { u, key };
}
function cookieStr(req, token, maxAge) { return `benga_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (isSecure(req) ? '; Secure' : ''); }
function startSession(ctx, uid) {
  const t = crypto.randomBytes(32).toString('hex'), now_ = Date.now();
  for (const [k, s] of Object.entries(D.sessions)) if (s.exp < now_) delete D.sessions[k];
  D.sessions[sha(t)] = { uid, exp: now_ + SESSION_MS };
  ctx.cookie = cookieStr(ctx.req, t, SESSION_MS / 1000);
}

async function verifyGoogle(cred) {
  if (!GOOGLE_CLIENT_ID) E('Login com Google não está ativo.', 404);
  let t;
  try { const r = await fetch((process.env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo') + '?id_token=' + encodeURIComponent(String(cred || '')));
    if (!r.ok) E('Não foi possível validar a conta Google.', 401); t = await r.json(); }
  catch (e) { if (e instanceof HttpError) throw e; E('Não foi possível contactar a Google. Tente de novo.', 502); }
  if (t.aud !== GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || String(t.email_verified) !== 'true' || !t.email || +t.exp * 1000 < Date.now()) E('Conta Google inválida.', 401);
  return t;
}

/* ---------- API ---------- */
async function api(ctx) {
  const { m, p, b, u, key, ip } = ctx, ok = { ok: 1 };
  const need = (...r) => { if (!u) E('Sessão inválida.', 401); if (r.length && !r.includes(u.role)) E('Sem permissão.', 403); };
  const only = (...ms) => { if (!ms.includes(m)) E('Método não permitido.', 405); };

  if (p === '/health') return ok;

  if (p === '/public') {
    const { pay_info, pay_methods, ...q } = D.S, del = D.orders.filter(o => o.status === 'Entregue');
    return { ...q,
      stat_envios: Math.round(num(D.S.stat_envios)) + del.length,
      stat_kg: Math.round(num(D.S.stat_kg) + del.reduce((a, o) => a + o.weight, 0)),
      stat_clientes: Math.round(num(D.S.stat_clientes)) + new Set(del.map(o => o.user_id)).size,
      cargo: D.cargo.map(c => ({ ...c })), google_client_id: GOOGLE_CLIENT_ID || null,
      reviews: D.rev.filter(r => r.status === 'Publicada').sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ user_id, ...r }) => r) };
  }

  if (p === '/me' && m === 'GET') { need(); return pubUser(u); }
  if (p === '/me' && m === 'PUT') {
    need();
    if (b.name !== undefined) { const n = T(b.name, 100); if (n.length < 2) E('Indique o seu nome.'); u.name = n; }
    if (b.phone !== undefined) u.phone = T(b.phone, 30);
    if (b.email !== undefined && T(b.email, 120).toLowerCase() !== u.email) { const e = T(b.email, 120).toLowerCase(); if (!EMAIL_RE.test(e)) E('E-mail inválido.'); if (D.users.some(x => x.email === e)) E('Este e-mail já está em uso.'); u.email = e; }
    if (b.prefs !== undefined) u.prefs = b.prefs === 'não' ? 'não' : 'sim';
    if (b.photo) { if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.photo) || b.photo.length > 250000) E('Imagem inválida ou demasiado grande.'); u.photo = b.photo; }
    if (b.password !== undefined && b.password !== '') {
      const np = String(b.password); if (np.length < 8 || np.length > 200) E('A palavra-passe deve ter pelo menos 8 caracteres.');
      if (u.pw && !checkPw(b.current_password || '', u.pw)) E('A palavra-passe atual está incorreta.');
      u.pw = hashPw(np); killSessions(u.id, key); logA(u, 'password', 'palavra-passe alterada');
    }
    return ok;
  }

  /* --- autenticação --- */
  if (p === '/auth/login') {
    only('POST'); const email = T(b.email, 120).toLowerCase(), fk = 'e:' + email, fi = 'i:' + ip;
    if (failCount(fk) >= 8 || failCount(fi) >= 25) E('Demasiadas tentativas. Aguarde alguns minutos e tente de novo.', 429);
    const x = D.users.find(x => x.email === email), good = checkPw(String(b.password || ''), x && x.pw);
    if (!x || !good) { addFail(fk); addFail(fi); E('E-mail ou palavra-passe incorretos.', 401); }
    if (x.blocked) E('Conta bloqueada. Contacte a BENGA.', 403);
    fails.delete(fk); startSession(ctx, x.id); logA(x, 'login', 'início de sessão'); return { role: x.role };
  }
  if (p === '/auth/register') {
    only('POST'); if (limited('reg:' + ip, 10, 3600e3)) E('Demasiados registos a partir desta ligação. Tente mais tarde.', 429);
    const name = T(b.name, 100), email = T(b.email, 120).toLowerCase(), phone = T(b.phone, 30), pw = String(b.password || '');
    if (name.length < 2 || !phone || !EMAIL_RE.test(email) || pw.length < 8 || pw.length > 200) E('Preencha todos os campos com dados válidos (palavra-passe mín. 8 caracteres).');
    if (D.users.some(x => x.email === email)) E('Este e-mail já está registado. Faça login.');
    const x = { id: D.nid++, name, email, phone, role: 'client', pw: hashPw(pw), created_at: now() }; D.users.push(x);
    startSession(ctx, x.id); logA(x, 'register', 'nova conta'); return { role: 'client' };
  }
  if (p === '/auth/google') {
    only('POST'); if (failCount('i:' + ip) >= 25) E('Demasiadas tentativas.', 429);
    const t = await verifyGoogle(b.credential), email = T(t.email, 120).toLowerCase(); let x = D.users.find(y => y.email === email);
    if (x && x.role !== 'client') E('Esta conta é da equipa BENGA. Use o e-mail e a palavra-passe.', 403);
    if (x && x.blocked) E('Conta bloqueada. Contacte a BENGA.', 403);
    if (!x) { x = { id: D.nid++, name: T(t.name || email.split('@')[0], 100), email, phone: '', role: 'client', pw: null, provider: 'google', created_at: now() }; D.users.push(x); logA(x, 'register', 'nova conta (Google)'); }
    startSession(ctx, x.id); return { role: 'client' };
  }
  if (p === '/auth/logout') { only('POST'); if (key) delete D.sessions[key]; ctx.cookie = cookieStr(ctx.req, '', 0); return ok; }
  if (p === '/auth/logout-all') { only('POST'); need(); killSessions(u.id); ctx.cookie = cookieStr(ctx.req, '', 0); return ok; }

  /* --- rastreio público --- */
  if (p.startsWith('/track/')) {
    if (limited('trk:' + ip, 40, 60e3)) E('Demasiadas consultas. Aguarde um minuto.', 429);
    const code = decodeURIComponent(p.slice(7)).trim().toUpperCase(), o = D.orders.find(o => o.tracking_code && o.tracking_code === code);
    if (!o) E('Código não encontrado. Encomendas pendentes ou recusadas não têm código de rastreio.', 404);
    return { code: o.tracking_code, client: o.name.split(' ')[0], origin: o.origin, destination: o.destination, weight: o.weight, cargo: o.cargo_type, status: o.status, date: o.created_at, value: o.total_eur, events: D.ev.filter(e => e.order_id === o.id).map(({ order_id, ...e }) => e) };
  }

  /* --- cliente --- */
  if (p === '/orders' && m === 'GET') { need('client'); return D.orders.filter(o => o.user_id === u.id).slice().reverse(); }
  if (p === '/orders' && m === 'POST') {
    need('client');
    const w = num(b.weight), vol = Math.max(1, Math.min(1000, parseInt(b.volumes) || 1)), city = ['Angola', 'Portugal'];
    const o = { name: T(b.name, 100), phone: T(b.phone, 30), email: T(b.email, 120).toLowerCase(), origin: T(b.origin, 20), destination: T(b.destination, 20), cargo_type: T(b.cargo_type, 60), description: T(b.description, 1000), delivery_mode: T(b.delivery_mode, 40), delivery_address: T(b.delivery_address, 300), notes: T(b.notes, 500) };
    if (!o.name || !o.phone || !EMAIL_RE.test(o.email) || !o.description || !(w > 0) || w > 5000) E('Preencha todos os campos obrigatórios (peso entre 0 e 5000 kg).');
    if (!city.includes(o.origin) || !city.includes(o.destination) || o.origin === o.destination) E('Origem e destino devem ser Angola e Portugal (diferentes).');
    if (!D.cargo.some(c => c.name === o.cargo_type)) E('Tipo de mercadoria inválido.');
    if (!['LEVANTAMENTO', 'ENTREGA AO DOMICÍLIO'].includes(o.delivery_mode)) E('Escolha o modo de recebimento.');
    if (o.delivery_mode === 'ENTREGA AO DOMICÍLIO' && !o.delivery_address) E('Indique a morada de entrega.');
    const ord = { id: D.nid++, user_id: u.id, ...o, weight: w, volumes: vol, status: 'Pendente', tracking_code: null, payment_status: 'Pendente', total_eur: Math.round(w * num(D.S.price_per_kg) * 100) / 100, created_at: now() };
    D.orders.push(ord); note(u.id, 'Solicitação de encomenda criada — pendente de aprovação.'); noteStaff(`Nova solicitação de encomenda #${ord.id} (${ord.name}, ${ord.origin} → ${ord.destination}, ${w} kg).`); logA(u, 'order_create', '#' + ord.id);
    const msg = `Olá BENGA ENVIOS! Nova solicitação:\nCliente: ${o.name}\nTelefone: ${o.phone}\nE-mail: ${o.email}\n${o.origin} → ${o.destination}\nTipo: ${o.cargo_type}\nDescrição: ${o.description}\nPeso: ${w} kg · Volumes: ${vol}\nRecebimento: ${o.delivery_mode} ${o.delivery_address}\nValor: ${ord.total_eur.toFixed(2)} €\nObs.: ${o.notes || '—'}\n\nPor favor, enviem os dados para pagamento.`;
    const wa = String(D.S.whatsapp || '').replace(/\D/g, '');
    return { id: ord.id, status: 'Pendente', whatsapp: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(msg)}` : null };
  }
  if (p === '/payments') { need('client'); return D.orders.filter(o => o.user_id === u.id).map(o => ({ created_at: o.created_at, amount: o.total_eur, method: 'Transferência bancária', status: o.payment_status, tracking_code: o.tracking_code, payment_deadline: o.payment_deadline || null })); }
  if (p === '/payment-info') { need('client'); const orders = D.orders.filter(o => o.user_id === u.id && o.tracking_code); const active = orders.filter(o => o.payment_status !== 'Pago' && o.payment_status !== 'Comprovativo submetido').sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''))[0]; return { available: !!active, order_id: active?.id || null, tracking_code: active?.tracking_code || null, amount: active?.total_eur || null, deadline: active?.payment_deadline || null, pay_methods: active ? D.S.pay_methods : '', pay_info: active ? D.S.pay_info : '' }; }
  const paymentSubmittedMatch = p.match(/^\/orders\/(\d+)\/payment-submitted$/);
  if (paymentSubmittedMatch && m === 'POST') { need('client'); const o = D.orders.find(x => x.id == paymentSubmittedMatch[1] && x.user_id === u.id); if (!o) E('Encomenda não encontrada.', 404); if (!o.tracking_code) E('O pagamento só fica disponível depois da aprovação.', 400); if (o.payment_status === 'Pago') E('Este pagamento já foi confirmado pela BENGA.', 400); o.payment_status = 'Comprovativo submetido'; o.payment_submitted_at = now(); noteStaff(`Cliente ${u.name} indicou pagamento da encomenda ${o.tracking_code}. Aguarda comprovativo e confirmação.`); note(u.id, `Pagamento indicado para ${o.tracking_code}. Envia agora o comprovativo pelo WhatsApp para a equipa confirmar.`); logA(u, 'payment_submitted', `${o.tracking_code}`); return { ok: 1, whatsapp: (() => { const wa = String(D.S.whatsapp || '').replace(/\D/g, ''); const msg = `Olá BENGA ENVIOS! Já efetuei o pagamento da encomenda ${o.tracking_code}. Valor: ${Number(o.total_eur).toFixed(2)} €. Vou enviar o comprovativo para confirmação.`; return wa ? `https://wa.me/${wa}?text=${encodeURIComponent(msg)}` : null; })() }; }
  if (p === '/notifications') { need(); return D.notif.filter(n => n.user_id === u.id).slice(-100).reverse(); }
  if (p === '/support' && m === 'POST') {
    need('client'); const s = T(b.subject, 120), msg = T(b.message, 2000); if (!s || !msg) E('Preencha assunto e mensagem.');
    if (limited('sup:' + u.id, 10, 3600e3)) E('Demasiados pedidos. Tente mais tarde.', 429);
    D.support.push({ id: D.nid++, user_id: u.id, name: u.name, email: u.email, phone: u.phone, subject: s, order_code: T(b.order_code, 30), message: msg, status: 'Nova', created_at: now() });
    noteStaff(`Nova mensagem de suporte de ${u.name}: ${s}`); return ok;
  }
  if (p === '/addresses' && m === 'GET') { need('client'); return D.addr.filter(a => a.user_id === u.id); }
  if (p === '/addresses' && m === 'POST') {
    need('client'); const a = { name: T(b.name, 80), phone: T(b.phone, 30), province: T(b.province, 80), municipality: T(b.municipality, 80), address: T(b.address, 300), reference: T(b.reference, 200) };
    if (!a.name || !a.address) E('Nome e morada são obrigatórios.');
    if (D.addr.filter(x => x.user_id === u.id).length >= 30 && !b.id) E('Limite de moradas atingido.');
    if (b.is_main) D.addr.forEach(x => x.user_id === u.id && (x.is_main = 0));
    const i = D.addr.findIndex(x => x.id == b.id && x.user_id === u.id);
    if (i >= 0) Object.assign(D.addr[i], a, { is_main: b.is_main ? 1 : 0 }); else D.addr.push({ ...a, id: D.nid++, user_id: u.id, is_main: b.is_main ? 1 : 0 });
    return ok;
  }
  if (p.startsWith('/addresses/') && m === 'DELETE') { need('client'); D.addr = D.addr.filter(a => !(a.id == p.split('/')[2] && a.user_id === u.id)); return ok; }
  if (p === '/reviews/mine') { need('client'); const r = D.rev.find(r => r.user_id === u.id); return r || null; }
  if (p === '/reviews' && m === 'POST') {
    need('client'); const st = parseInt(b.stars), tx = T(b.text, 400), del = D.orders.filter(o => o.user_id === u.id && o.status === 'Entregue');
    if (!del.length) E('Só pode avaliar depois de receber uma encomenda (estado Entregue).');
    if (D.rev.some(r => r.user_id === u.id)) E('Já enviou a sua avaliação. Obrigado!');
    if (!(st >= 1 && st <= 5)) E('Escolha uma nota de 1 a 5.'); if (tx.length < 10) E('Escreva um comentário com pelo menos 10 caracteres.');
    const o = del[del.length - 1], nm = u.name.trim().split(/\s+/);
    D.rev.push({ id: D.nid++, user_id: u.id, name: nm[0] + (nm[1] ? ' ' + nm[1][0].toUpperCase() + '.' : ''), route: o.origin + ' → ' + o.destination, stars: st, text: tx, status: 'Pendente', verified: true, created_at: now() });
    note(u.id, 'Avaliação enviada — será publicada após revisão da BENGA.'); noteStaff('Nova avaliação de cliente à espera de revisão.'); logA(u, 'review', 'nova avaliação ' + st + '★'); return ok;
  }

  /* --- administração (admin / funcionário) --- */
  if (p === '/admin/stats') {
    need('admin', 'staff'); const c = s => D.orders.filter(o => o.status === s).length, g = k => Object.entries(D.orders.reduce((a, o) => { const x = k(o); a[x] = (a[x] || 0) + 1; return a; }, {})).map(([r, n]) => ({ r, n }));
    return { total: D.orders.length, pending: c('Pendente'), transit: c('Em trânsito'), delivered: c('Entregue'), clients: D.users.filter(x => x.role === 'client').length, revenue: D.orders.filter(o => o.payment_status === 'Pago').reduce((a, o) => a + o.total_eur, 0), byRoute: g(o => o.origin + ' → ' + o.destination), byCargo: g(o => o.cargo_type), activity: D.log.slice(-8).reverse() };
  }
  if (p === '/admin/orders' && m === 'GET') { need('admin', 'staff'); return D.orders.slice().reverse(); }
  let r = p.match(/^\/admin\/orders\/(\d+)\/(approve|refuse|status|payment)$/);
  if (r) {
    only('POST'); const a = r[2]; if (a === 'approve' || a === 'refuse') need('admin'); else need('admin', 'staff');
    const o = D.orders.find(o => o.id == r[1]); if (!o) E('Encomenda não encontrada.', 404);
    if (a === 'approve') { need('admin'); if (o.status !== 'Pendente') E('Só solicitações pendentes podem ser aprovadas.');
      const y = new Date().getFullYear(); D.seqs[y] = (D.seqs[y] || 0) + 1; o.tracking_code = `BEN-${y}-${String(D.seqs[y]).padStart(6, '0')}`; o.status = 'Aprovada'; o.decided_at = now(); o.payment_deadline = plusMinutes(30); o.payment_status = 'Pendente';
      evAdd(o, 'Encomenda aprovada', T(b.notes, 300)); note(o.user_id, 'Encomenda aprovada. Código de rastreio: ' + o.tracking_code); logA(u, 'approve', `#${o.id} ${o.tracking_code}`); return { code: o.tracking_code }; }
    if (a === 'refuse') { need('admin'); if (o.status !== 'Pendente') E('Só solicitações pendentes podem ser recusadas.'); const rs = T(b.reason, 300); if (!rs) E('Indique o motivo da recusa.');
      o.status = 'Recusada'; o.refusal_reason = rs; note(o.user_id, 'Encomenda recusada. Consulte o motivo em Minhas encomendas.'); logA(u, 'refuse', `#${o.id}: ${rs}`); return ok; }
    if (a === 'status') { need('admin', 'staff'); const st = T(b.status, 40); if (!o.tracking_code || !D.S.states.split(',').includes(st)) E('Estados operacionais só após a aprovação e dentro da lista definida.');
      o.status = st; evAdd(o, st); if (D.S.notif_status !== 'não') note(o.user_id, `Encomenda ${o.tracking_code}: ${st}`); logA(u, 'status', `#${o.id} → ${st}`); return ok; }
    need('admin', 'staff'); const ps = T(b.status, 20); if (!['Pendente', 'Em análise', 'Pago', 'Cancelado'].includes(ps)) E('Estado de pagamento inválido.');
    o.payment_status = ps; if (ps === 'Pago' && D.S.notif_payment !== 'não') note(o.user_id, 'Pagamento confirmado.'); logA(u, 'payment', `#${o.id} → ${ps}`); return ok;
  }
  if (p === '/admin/clients' && m === 'GET') { need('admin'); return D.users.filter(x => x.role === 'client').map(x => ({ ...pubUser(x), orders: D.orders.filter(o => o.user_id === x.id).length })); }
  r = p.match(/^\/admin\/clients\/(\d+)\/block$/);
  if (r) { only('POST'); need('admin'); const x = D.users.find(x => x.id == r[1] && x.role === 'client'); if (!x) E('Cliente não encontrado.', 404); x.blocked = b.blocked ? 1 : 0; if (x.blocked) killSessions(x.id); logA(u, 'block', `${x.email} → ${x.blocked ? 'bloqueado' : 'ativo'}`); return ok; }
  r = p.match(/^\/admin\/(clients|users)\/(\d+)\/reset-password$/);
  if (r) {
    only('POST'); need('admin'); const x = D.users.find(x => x.id == r[2] && (r[1] === 'clients') === (x.role === 'client')); if (!x) E('Utilizador não encontrado.', 404); if (x.id === u.id) E('Use as definições da sua conta para mudar a sua palavra-passe.');
    const pw = crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 10); x.pw = hashPw(pw); killSessions(x.id); logA(u, 'reset_password', x.email); return { password: pw };
  }
  if (p === '/admin/settings') {
    need('admin'); if (m === 'GET') return { ...D.S }; only('PUT', 'POST');
    for (const [k, v] of Object.entries(b)) {
      if (!(k in D.S)) continue; const cur = D.S[k];
      if (k === 'zones') { if (!Array.isArray(v) || v.length > 50) E('Zonas inválidas.'); D.S.zones = v.map(z => ({ name: T(z.name, 80), province: T(z.province, 80), min: Math.max(0, num(z.min)), max: Math.max(0, num(z.max)) })).filter(z => z.name); }
      else if (k === 'states') { const l = [...new Set(String(v).split(',').map(s => T(s, 40)).filter(Boolean))]; if (!l.includes('Entregue')) E('A lista de estados tem de incluir "Entregue".'); D.S.states = l.join(','); }
      else if (k === 'whatsapp') D.S.whatsapp = String(v).replace(/\D/g, '').slice(0, 20);
      else if (typeof cur === 'number') { const n = parseFloat(v); if (!Number.isFinite(n) || n < 0 || n > 1e9) E('Valor numérico inválido (' + k + ').'); D.S[k] = n; }
      else D.S[k] = T(v, k === 'pay_info' ? 2000 : 300);
    }
    logA(u, 'settings', 'configurações alteradas'); return { ...D.S };
  }
  if (p === '/admin/cargo' && m === 'POST') { need('admin'); const n = T(b.name, 60); if (!n) E('Indique o nome.'); if (!D.cargo.some(c => c.name.toLowerCase() === n.toLowerCase())) D.cargo.push({ id: D.nid++, name: n }); return ok; }
  if (p.startsWith('/admin/cargo/') && m === 'DELETE') { need('admin'); D.cargo = D.cargo.filter(c => c.id != p.split('/')[3]); return ok; }
  if (p === '/admin/audit') { need('admin', 'staff'); return D.log.slice(-300).reverse(); }
  if (p === '/admin/users' && m === 'GET') { need('admin'); return D.users.filter(x => x.role !== 'client').map(pubUser); }
  if (p === '/admin/users' && m === 'POST') {
    need('admin'); const name = T(b.name, 100), email = T(b.email, 120).toLowerCase(), pw = String(b.password || '');
    if (name.length < 2 || !EMAIL_RE.test(email) || pw.length < 8 || !['admin', 'staff'].includes(b.role)) E('Dados inválidos (palavra-passe mín. 8 caracteres).');
    if (D.users.some(x => x.email === email)) E('Este e-mail já está registado.');
    D.users.push({ id: D.nid++, name, email, phone: '', role: b.role, pw: hashPw(pw), created_at: now() }); logA(u, 'user_create', `${email} (${b.role})`); return ok;
  }
  r = p.match(/^\/admin\/users\/(\d+)\/(role|block)$/);
  if (r) {
    only('POST'); need('admin'); const x = D.users.find(x => x.id == r[1] && x.role !== 'client'); if (!x) E('Utilizador não encontrado.', 404); if (x.id === u.id) E('Não pode alterar a sua própria conta aqui.');
    if (r[2] === 'role') { if (!['admin', 'staff'].includes(b.role)) E('Função inválida.'); x.role = b.role; logA(u, 'role', `${x.email} → ${b.role}`); }
    else { x.blocked = b.blocked ? 1 : 0; if (x.blocked) killSessions(x.id); logA(u, 'block', `${x.email} → ${x.blocked ? 'bloqueado' : 'ativo'}`); }
    return ok;
  }
  if (p === '/admin/support' && m === 'GET') { need('admin', 'staff'); return D.support.slice().reverse(); }
  r = p.match(/^\/admin\/support\/(\d+)\/resolve$/);
  if (r) { only('POST'); need('admin', 'staff'); const x = D.support.find(s => s.id == r[1]); if (!x) E('Mensagem não encontrada.', 404); x.status = b.status === 'Nova' ? 'Nova' : 'Resolvida'; return ok; }
  if (p === '/admin/reviews' && m === 'GET') { need('admin'); return D.rev.slice().reverse(); }
  if (p === '/admin/reviews' && m === 'POST') {
    need('admin'); const st = parseInt(b.stars), tx = T(b.text, 400), nm = T(b.name, 60);
    if (!nm || !(st >= 1 && st <= 5) || tx.length < 10) E('Indique nome, nota (1–5) e comentário (mín. 10 caracteres).');
    D.rev.push({ id: D.nid++, name: nm, route: T(b.route, 60), stars: st, text: tx, status: 'Publicada', created_at: now() }); logA(u, 'review', 'avaliação adicionada manualmente'); return ok;
  }
  r = p.match(/^\/admin\/reviews\/(\d+)\/(status|delete)$/);
  if (r) {
    only('POST'); need('admin'); const x = D.rev.find(v => v.id == r[1]); if (!x) E('Avaliação não encontrada.', 404);
    if (r[2] === 'delete') D.rev = D.rev.filter(v => v !== x); else { if (!['Publicada', 'Oculta'].includes(b.status)) E('Estado inválido.'); x.status = b.status; }
    logA(u, 'review', `${r[2]} #${x.id}`); return ok;
  }
  E('Não encontrado.', 404);
}

/* ---------- HTTP ---------- */
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexCache = null;
function indexData() {
  if (!indexCache || process.env.NODE_ENV !== 'production') { const raw = fs.readFileSync(INDEX); indexCache = { raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: '"' + sha(raw.toString('latin1')).slice(0, 20) + '"' }; }
  return indexCache;
}
function secHeaders(req, res) {
  const g = GOOGLE_CLIENT_ID ? ' https://accounts.google.com/gsi/client' : '';
  res.setHeader('Content-Security-Policy', ["default-src 'self'", `script-src 'self' 'unsafe-inline'${g}`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${GOOGLE_CLIENT_ID ? ' https://accounts.google.com/gsi/style' : ''}`, "font-src https://fonts.gstatic.com", "img-src 'self' data:", `connect-src 'self'${GOOGLE_CLIENT_ID ? ' https://accounts.google.com/gsi/' : ''}`, GOOGLE_CLIENT_ID ? "frame-src https://accounts.google.com/gsi/" : "frame-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function send(res, status, obj, extra = {}) { const body = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(body); }
function readBody(req, limit = 400 * 1024) {
  return new Promise((resolve, reject) => { let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Pedido demasiado grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve({}); try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch { reject(new HttpError(400, 'Pedido inválido.')); } });
    req.on('error', reject); });
}
async function handler(req, res) {
  secHeaders(req, res);
  const url = new URL(req.url, 'http://localhost'), pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const ip = ipOf(req); if (limited('api:' + ip, 600, 5 * 60e3)) E('Demasiados pedidos. Aguarde um momento.', 429);
      const m = req.method;
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(m)) E('Método não permitido.', 405);
      if (m !== 'GET') {
        const org = req.headers.origin; if (org) { let h = ''; try { h = new URL(org).host; } catch { } if (h !== req.headers.host) E('Origem não permitida.', 403); }
        if (req.headers['content-length'] > 0 && !String(req.headers['content-type'] || '').includes('application/json')) E('Tipo de conteúdo inválido.', 415);
      }
      const b = m === 'GET' ? {} : await readBody(req), { u, key } = sessionOf(req), ctx = { req, m, p: pathname.slice(4), b, u, key, ip, cookie: null };
      const out = await api(ctx); if (m !== 'GET') save();
      return send(res, 200, out === undefined ? { ok: 1 } : out, ctx.cookie ? { 'Set-Cookie': ctx.cookie } : {});
    }
    if (pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (pathname === '/' || pathname === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') E('Método não permitido.', 405);
      const d = indexData(), h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: d.etag, Vary: 'Accept-Encoding' };
      if (req.headers['if-none-match'] === d.etag) { res.writeHead(304, h); return res.end(); }
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(req.method === 'HEAD' ? undefined : d.gz); }
      res.writeHead(200, h); return res.end(req.method === 'HEAD' ? undefined : d.raw);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Página não encontrada.');
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) return send(res, e.status, { error: e.message }); return res.end(); }
    console.error('[erro]', req.method, req.url, e); if (!res.headersSent) send(res, 500, { error: 'Erro interno. Tente novamente.' }); else res.end();
  }
}

function start() {
  load(); seedAdmin();
  const server = http.createServer(handler); server.headersTimeout = 15000; server.requestTimeout = 30000;
  server.listen(PORT, () => {
    console.log(`BENGA ENVIOS a correr em http://localhost:${PORT}`);
    if (!D.S.whatsapp) console.log('⚠  WhatsApp ainda não configurado: Painel admin → Configurações da Benga → Contactos.');
    if (!GOOGLE_CLIENT_ID) console.log('ℹ  Login com Google desativado (defina GOOGLE_CLIENT_ID para ativar).');
  });
  const bye = () => { try { save(); } catch { } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  return server;
}
module.exports = { hashPw, DB_FILE, start };
if (require.main === module) start();
