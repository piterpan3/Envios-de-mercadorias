'use strict';
/* Teste de integração: arranca o servidor numa pasta temporária e percorre os fluxos reais. Uso: node test/api.test.js */
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const PORT = 3200 + Math.floor(Math.random() * 500), BASE = 'http://localhost:' + PORT;
const ADMIN = { email: 'admin@teste.pt', password: 'Admin-Teste-12345' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benga-'));
let pass = 0, fail = 0, proc;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✔', name); } else { fail++; console.log('  ✘', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); } };

class Client { constructor() { this.cookie = ''; }
  async call(method, p, body, headers = {}) {
    const r = await fetch(BASE + '/api' + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    let j = {}; try { j = await r.json(); } catch { } return { s: r.status, j, h: r.headers };
  } }
function startServer(env = {}) {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ...env }, stdio: 'pipe' });
  return new Promise(res => { let t = ''; proc.stdout.on('data', d => { t += d; if (t.includes('a correr')) res(); }); proc.stderr.on('data', d => process.stderr.write(d)); });
}
const stop = () => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });

(async () => {
  await startServer();
  const adm = new Client(), cli = new Client(), anon = new Client(), cli2 = new Client();

  console.log('\n# Ficheiro de dados e arranque');
  const raw = fs.readFileSync(path.join(dir, 'benga.json'), 'utf8');
  ok('palavra-passe do admin não está em texto no ficheiro', !raw.includes(ADMIN.password) && raw.includes('scrypt$'));
  ok('sem dados de demonstração (0 encomendas, 0 avaliações)', JSON.parse(raw).orders.length === 0 && JSON.parse(raw).rev.length === 0 && JSON.parse(raw).users.length === 1);

  console.log('\n# Público');
  let r = await anon.call('GET', '/public');
  ok('/public sem segredos (pay_info) e sem avaliações', r.s === 200 && !('pay_info' in r.j) && r.j.reviews.length === 0 && r.j.stat_envios === 0);
  r = await anon.call('GET', '/me'); ok('/me sem sessão → 401', r.s === 401);
  r = await anon.call('GET', '/track/BEN-2026-000001'); ok('rastreio de código inexistente → 404', r.s === 404);
  const page = await fetch(BASE + '/', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('página inicial servida (gzip + CSP + nosniff)', page.status === 200 && page.headers.get('content-encoding') === 'gzip' && /default-src 'self'/.test(page.headers.get('content-security-policy')) && page.headers.get('x-content-type-options') === 'nosniff');
  const html = await (await fetch(BASE + '/')).text();
  ok('HTML sem restos de demo', !/MODO DEMO|VERSÃO DEMO|cliente@demo|admin@demo|Cliente Demo|EXEMPLO/.test(html));
  ok('HTML não contém a senha do admin nem hashes', !html.includes(ADMIN.password) && !html.includes('scrypt$'));

  console.log('\n# Login do administrador');
  r = await adm.call('POST', '/auth/login', { email: ADMIN.email, password: 'errada' }); ok('senha errada → 401', r.s === 401);
  r = await adm.call('POST', '/auth/login', { email: ' ' + ADMIN.email.toUpperCase() + ' ', password: ADMIN.password });
  ok('login admin (e-mail normalizado)', r.s === 200 && r.j.role === 'admin');
  ok('cookie httpOnly + SameSite', /HttpOnly/.test(r.h.get('set-cookie')) && /SameSite=Lax/.test(r.h.get('set-cookie')));
  r = await adm.call('GET', '/me'); ok('/me não devolve hash da senha', r.s === 200 && !JSON.stringify(r.j).includes('scrypt') && r.j.role === 'admin');

  console.log('\n# Registo e permissões do cliente');
  r = await cli.call('POST', '/auth/register', { name: 'Maria Silva', email: 'maria@exemplo.pt', phone: '+351900000000', password: 'curta' }); ok('palavra-passe curta rejeitada', r.s === 400);
  r = await cli.call('POST', '/auth/register', { name: 'Maria Silva', email: 'maria@exemplo.pt', phone: '+351900000000', password: 'Maria-Senha-1' }); ok('registo OK + sessão', r.s === 200 && r.j.role === 'client');
  r = await anon.call('POST', '/auth/register', { name: 'Outro', email: ADMIN.email, phone: '1', password: 'Outra-Senha-1' }); ok('não regista o e-mail do admin', r.s === 400);
  for (const p of ['/admin/stats', '/admin/orders', '/admin/clients', '/admin/settings', '/admin/audit', '/admin/users', '/admin/support', '/admin/reviews'])
    { r = await cli.call('GET', p); if (r.s !== 403) { ok('cliente bloqueado em ' + p, false, r.s); } }
  ok('cliente não acede a nenhuma rota /admin (403)', true);
  r = await cli.call('POST', '/admin/orders/1/approve', {}); ok('cliente não aprova encomendas', r.s === 403);
  r = await anon.call('GET', '/orders'); ok('anónimo não vê encomendas (401)', r.s === 401);

  console.log('\n# Encomenda');
  const ord = { name: 'Maria Silva', phone: '+351900000000', email: 'maria@exemplo.pt', origin: 'Portugal', destination: 'Angola', cargo_type: 'Roupa', description: 'Caixa de roupa', weight: '8', volumes: '2', delivery_mode: 'LEVANTAMENTO', notes: '' };
  r = await cli.call('POST', '/orders', { ...ord, origin: 'Angola' }); ok('origem = destino rejeitada', r.s === 400);
  r = await cli.call('POST', '/orders', { ...ord, weight: '-3' }); ok('peso negativo rejeitado', r.s === 400);
  r = await cli.call('POST', '/orders', { ...ord, cargo_type: 'Armas' }); ok('tipo de mercadoria inválido rejeitado', r.s === 400);
  r = await cli.call('POST', '/orders', { ...ord, delivery_mode: 'ENTREGA AO DOMICÍLIO' }); ok('entrega sem morada rejeitada', r.s === 400);
  r = await cli.call('POST', '/orders', { ...ord, status: 'Entregue', tracking_code: 'BEN-2026-999999', payment_status: 'Pago', total_eur: 0.01, user_id: 1 });
  ok('solicitação criada (Pendente, sem código)', r.s === 200 && r.j.status === 'Pendente' && r.j.whatsapp === null);
  const oid = r.j.id; r = await cli.call('GET', '/orders'); const o = r.j[0];
  ok('campos protegidos não podem ser forçados (status/código/pagamento/valor)', o.status === 'Pendente' && o.tracking_code === null && o.payment_status === 'Pendente' && o.total_eur === 100 && o.user_id !== 1);
  r = await anon.call('GET', '/track/' + 'BEN-2026-999999'); ok('código falso não existe', r.s === 404);

  console.log('\n# Aprovação, estados e rastreio');
  r = await cli.call('GET', '/payment-info'); ok('dados de transferência escondidos antes da aprovação', r.s === 200 && r.j.available === false && r.j.pay_info === '');
  r = await anon.call('GET', '/payment-info'); ok('anónimo não vê dados de pagamento (401)', r.s === 401);
  r = await anon.call('GET', '/public'); ok('dados de pagamento não aparecem no site público', !JSON.stringify(r.j).includes('IBAN') && !('pay_info' in r.j));
  r = await adm.call('GET', '/admin/stats'); ok('admin vê 1 pendente', r.j.pending === 1 && r.j.total === 1);
  r = await adm.call('GET', '/notifications'); ok('admin foi notificado da nova solicitação', r.j.some(n => /Nova solicitação/.test(n.text)));
  r = await adm.call('POST', `/admin/orders/${oid}/status`, { status: 'Em trânsito' }); ok('não muda estado antes de aprovar', r.s === 400);
  r = await adm.call('POST', `/admin/orders/${oid}/refuse`, { reason: '' }); ok('recusa exige motivo', r.s === 400);
  r = await adm.call('POST', `/admin/orders/${oid}/approve`, {}); const code = r.j.code;
  ok('aprovada com código BEN-AAAA-000001', r.s === 200 && /^BEN-\d{4}-000001$/.test(code), r.j);
  r = await adm.call('POST', `/admin/orders/${oid}/approve`, {}); ok('não aprova duas vezes', r.s === 400);
  r = await adm.call('POST', `/admin/orders/${oid}/status`, { status: 'Inventado' }); ok('estado fora da lista rejeitado', r.s === 400);
  r = await cli.call('GET', '/payment-info'); ok('depois de aprovada, o cliente vê os dados de transferência', r.j.available === true && /Rachid Gomes/.test(r.j.pay_info) && /PT50 0193 0000 10507750890 11/.test(r.j.pay_info));
  r = await adm.call('POST', `/admin/orders/${oid}/status`, { status: 'Em trânsito' }); ok('estado "Em trânsito"', r.s === 200);
  r = await adm.call('POST', `/admin/orders/${oid}/payment`, { status: 'Pago' }); ok('pagamento marcado Pago', r.s === 200);
  r = await anon.call('GET', '/track/' + code.toLowerCase()); ok('rastreio público (código em minúsculas)', r.s === 200 && r.j.status === 'Em trânsito' && r.j.client === 'Maria' && r.j.events.length === 2);
  ok('rastreio não expõe telefone/e-mail/nome completo', !/900000000|maria@|Silva/.test(JSON.stringify(r.j)));
  r = await cli.call('GET', '/notifications'); ok('cliente recebeu as notificações', r.j.some(n => n.text.includes(code)));

  console.log('\n# Avaliações (só depois de entregue)');
  r = await cli.call('POST', '/reviews', { stars: 5, text: 'Serviço excelente, recomendo!' }); ok('não avalia antes da entrega', r.s === 400);
  await adm.call('POST', `/admin/orders/${oid}/status`, { status: 'Entregue' });
  r = await cli.call('POST', '/reviews', { stars: 5, text: 'Serviço excelente, recomendo!' }); ok('avalia depois de entregue', r.s === 200);
  r = await cli.call('POST', '/reviews', { stars: 5, text: 'Serviço excelente, recomendo!' }); ok('só uma avaliação por cliente', r.s === 400);
  r = await anon.call('GET', '/public'); ok('avaliação pendente não é pública; números reais: 1 envio, 8 kg, 1 cliente', r.j.reviews.length === 0 && r.j.stat_envios === 1 && r.j.stat_kg === 8 && r.j.stat_clientes === 1, [r.j.stat_envios, r.j.stat_kg, r.j.stat_clientes]);
  r = await adm.call('GET', '/admin/reviews'); const rid = r.j[0].id;
  r = await adm.call('POST', `/admin/reviews/${rid}/status`, { status: 'Publicada' }); ok('admin publica a avaliação', r.s === 200);
  r = await anon.call('GET', '/public'); ok('avaliação aparece no site (verificada, sem user_id)', r.j.reviews.length === 1 && r.j.reviews[0].verified === true && !('user_id' in r.j.reviews[0]) && r.j.reviews[0].name === 'Maria S.');

  console.log('\n# Suporte, moradas, configurações');
  r = await cli.call('POST', '/support', { subject: 'Dúvida', message: 'Quando chega?', order_code: code }); ok('mensagem de suporte guardada', r.s === 200);
  r = await adm.call('GET', '/admin/support'); ok('admin vê a mensagem de suporte', r.j.length === 1 && r.j[0].subject === 'Dúvida');
  r = await cli.call('POST', '/addresses', { name: 'Casa', address: 'Rua A', province: 'Luanda', is_main: true }); ok('morada criada', r.s === 200);
  r = await cli.call('GET', '/addresses'); const aid = r.j[0].id; r = await cli.call('DELETE', '/addresses/' + aid); ok('morada eliminada', r.s === 200);
  r = await adm.call('PUT', '/admin/settings', { price_per_kg: 'abc' }); ok('preço inválido rejeitado', r.s === 400);
  r = await adm.call('PUT', '/admin/settings', { states: 'Recebida,Em trânsito' }); ok('estados sem "Entregue" rejeitados', r.s === 400);
  r = await adm.call('PUT', '/admin/settings', { price_per_kg: '15', whatsapp: '+244 923 000 000', stat_envios: '100', hacker: 'x' }); ok('configurações guardadas (WhatsApp só dígitos)', r.s === 200 && r.j.price_per_kg === 15 && r.j.whatsapp === '244923000000' && !('hacker' in r.j));
  r = await anon.call('GET', '/public'); ok('site público usa o novo preço e soma o histórico (101 envios)', r.j.price_per_kg === 15 && r.j.stat_envios === 101);
  r = await cli.call('POST', '/orders', { ...ord, weight: '2' }); ok('nova encomenda: WhatsApp configurado gera link wa.me', r.s === 200 && /^https:\/\/wa\.me\/244923000000\?text=/.test(r.j.whatsapp));

  console.log('\n# Contas, palavras-passe e administração');
  r = await cli.call('PUT', '/me', { password: 'Nova-Senha-123' }); ok('trocar senha exige a atual', r.s === 400);
  r = await cli.call('PUT', '/me', { password: 'Nova-Senha-123', current_password: 'Maria-Senha-1' }); ok('trocar senha com a atual', r.s === 200);
  r = await cli2.call('POST', '/auth/login', { email: 'maria@exemplo.pt', password: 'Maria-Senha-1' }); ok('senha antiga deixa de funcionar', r.s === 401);
  r = await cli2.call('POST', '/auth/login', { email: 'maria@exemplo.pt', password: 'Nova-Senha-123' }); ok('login com a nova senha', r.s === 200);
  r = await cli.call('PUT', '/me', { email: ADMIN.email }); ok('não muda e-mail para um já em uso', r.s === 400);
  r = await adm.call('GET', '/admin/clients'); const mid = r.j[0].id; ok('lista de clientes sem hashes', !JSON.stringify(r.j).includes('scrypt'));
  r = await adm.call('POST', `/admin/clients/${mid}/reset-password`, {}); const tmp = r.j.password;
  ok('admin repõe a senha do cliente (temporária)', r.s === 200 && tmp && tmp.length >= 8);
  r = await cli.call('GET', '/me'); ok('sessões do cliente terminadas após reposição', r.s === 401);
  r = await cli.call('POST', '/auth/login', { email: 'maria@exemplo.pt', password: tmp }); ok('cliente entra com a senha temporária', r.s === 200);
  r = await adm.call('POST', `/admin/clients/${mid}/block`, { blocked: 1 }); ok('admin bloqueia o cliente', r.s === 200);
  r = await cli.call('GET', '/me'); ok('cliente bloqueado perde a sessão', r.s === 401);
  r = await cli.call('POST', '/auth/login', { email: 'maria@exemplo.pt', password: tmp }); ok('cliente bloqueado não entra', r.s === 403);
  r = await adm.call('POST', '/admin/users', { name: 'Func', email: 'func@teste.pt', password: 'Func-Senha-123', role: 'superuser' }); ok('função inválida rejeitada', r.s === 400);
  r = await adm.call('POST', '/admin/users', { name: 'Func', email: 'func@teste.pt', password: 'Func-Senha-123', role: 'staff' }); ok('admin cria funcionário', r.s === 200);
  const fn = new Client(); r = await fn.call('POST', '/auth/login', { email: 'func@teste.pt', password: 'Func-Senha-123' });
  r = await fn.call('GET', '/admin/orders'); ok('funcionário vê encomendas', r.s === 200);
  r = await fn.call('POST', '/admin/orders/1/approve', {}); ok('funcionário NÃO aprova', r.s === 403);
  r = await fn.call('GET', '/admin/settings'); ok('funcionário NÃO acede a configurações', r.s === 403);
  r = await fn.call('GET', '/admin/users'); ok('funcionário NÃO gere utilizadores', r.s === 403);
  r = await adm.call('GET', '/admin/users'); const admId = r.j.find(x => x.email === ADMIN.email).id;
  r = await adm.call('POST', `/admin/users/${admId}/role`, { role: 'staff' }); ok('admin não se rebaixa a si próprio', r.s === 400);
  r = await adm.call('POST', `/admin/users/${admId}/block`, { blocked: 1 }); ok('admin não se bloqueia a si próprio', r.s === 400);
  r = await adm.call('GET', '/admin/audit'); ok('auditoria com nomes reais', r.j.length > 5 && r.j.some(l => l.name && l.name !== 'Admin Demo' && l.action === 'approve'));

  console.log('\n# Segurança');
  const evil = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ email: 'a@b.pt', password: 'x' }) }); ok('pedido de outra origem recusado (CSRF)', evil.status === 403);
  const txt = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"a":1}' }); ok('content-type não-JSON recusado', txt.status === 415);
  const big = await fetch(BASE + '/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(500000) }) }).catch(() => ({ status: 413 })); ok('corpo gigante recusado', big.status === 413);
  const bad = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nao json' }); ok('JSON inválido → 400', bad.status === 400);
  const xs = new Client(); await xs.call('POST', '/auth/register', { name: 'Carlos <b>X</b>', email: 'carlos@exemplo.pt', phone: '1', password: 'Carlos-Senha-1' });
  await xs.call('POST', '/orders', { ...ord, description: '<img src=x onerror=alert(1)>' }); r = await xs.call('GET', '/orders'); ok('texto malicioso guardado como texto (o site escapa ao mostrar)', r.s === 200 && r.j[0].description === '<img src=x onerror=alert(1)>');
  const brute = new Client(); let last; for (let i = 0; i < 10; i++) last = await brute.call('POST', '/auth/login', { email: 'brute@teste.pt', password: 'x' + i }); ok('força bruta bloqueada (429 após várias falhas)', last.s === 429, last.s);
  const trk = new Client(); let t429 = false; for (let i = 0; i < 60; i++) { const q = await trk.call('GET', '/track/BEN-2026-' + String(i).padStart(6, '0')); if (q.s === 429) { t429 = true; break; } } ok('enumeração de códigos de rastreio limitada', t429);
  r = await anon.call('GET', '/auth/google'); ok('Google inativo sem GOOGLE_CLIENT_ID', r.s !== 200);
  r = await anon.call('GET', '/naoexiste'); ok('rota API desconhecida → 404 JSON', r.s === 404);
  r = await adm.call('POST', '/auth/logout'); r = await adm.call('GET', '/admin/stats'); ok('logout termina a sessão', r.s === 401);

  console.log('\n# Persistência (reiniciar o servidor)');
  await stop(); await startServer();
  const adm2 = new Client(); r = await adm2.call('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password }); ok('admin entra depois do reinício', r.s === 200);
  r = await adm2.call('GET', '/admin/orders'); ok('encomendas sobreviveram ao reinício', r.j.length === 3 && r.j.some(x => x.tracking_code === code));
  r = await anon.call('GET', '/public'); ok('avaliação e configurações persistidas', r.j.reviews.length === 1 && r.j.price_per_kg === 15);
  r = await anon.call('GET', '/track/' + code); ok('rastreio continua a funcionar', r.s === 200 && r.j.status === 'Entregue');
  ok('cópia de segurança diária criada', fs.readdirSync(path.join(dir, 'backups')).length === 1);
  await stop();

  console.log('\n# Login com Google (verificação do token, com servidor Google simulado)');
  const goog = http.createServer((q, s) => { const t = new URL(q.url, 'http://x').searchParams.get('id_token'); const base = { aud: 'cid-123', iss: 'https://accounts.google.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 600) };
    const m = { good: { ...base, email: 'ana@gmail.com', name: 'Ana Gmail' }, wrongaud: { ...base, aud: 'outro', email: 'x@gmail.com' }, unverified: { ...base, email: 'y@gmail.com', email_verified: 'false' }, admin: { ...base, email: ADMIN.email, name: 'Falso Admin' }, expired: { ...base, email: 'z@gmail.com', exp: '1' } }[t];
    s.writeHead(m ? 200 : 400, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(m || { error: 'invalid' })); });
  await new Promise(r => goog.listen(0, r)); const gp = goog.address().port;
  await startServer({ GOOGLE_CLIENT_ID: 'cid-123', GOOGLE_TOKENINFO_URL: `http://localhost:${gp}/tokeninfo` });
  const g = new Client(); r = await g.call('GET', '/public'); ok('google_client_id exposto ao site', r.j.google_client_id === 'cid-123');
  r = await g.call('POST', '/auth/google', { credential: 'wrongaud' }); ok('token com audiência errada recusado', r.s === 401);
  r = await g.call('POST', '/auth/google', { credential: 'unverified' }); ok('e-mail não verificado recusado', r.s === 401);
  r = await g.call('POST', '/auth/google', { credential: 'expired' }); ok('token expirado recusado', r.s === 401);
  r = await g.call('POST', '/auth/google', { credential: 'lixo' }); ok('token inválido recusado', r.s === 401);
  r = await g.call('POST', '/auth/google', { credential: 'admin' }); ok('Google nunca dá acesso a conta de admin', r.s === 403);
  r = await g.call('POST', '/auth/google', { credential: 'good' }); ok('login Google cria cliente', r.s === 200 && r.j.role === 'client');
  r = await g.call('GET', '/me'); ok('conta Google sem palavra-passe', r.j.email === 'ana@gmail.com' && r.j.has_password === false && r.j.provider === 'google');
  const pg = await fetch(BASE + '/'); ok('CSP permite o script do Google quando ativo', /accounts\.google\.com\/gsi\/client/.test(pg.headers.get('content-security-policy')));
  const gl = new Client(); r = await gl.call('POST', '/auth/login', { email: 'ana@gmail.com', password: '' }); ok('conta Google não entra com senha vazia', r.s === 401);
  await stop(); goog.close();

  console.log('\n# Primeira execução sem ADMIN_PASSWORD');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'benga-')); const p2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: PORT + 1, DATA_DIR: d2, ADMIN_EMAIL: '', ADMIN_PASSWORD: '' }, stdio: 'pipe' });
  const code2 = await new Promise(res => p2.on('exit', res)); ok('recusa arrancar sem credenciais de admin', code2 === 1);

  console.log(`\n${pass} passaram, ${fail} falharam`); fs.rmSync(dir, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE', e); try { proc.kill(); } catch { } process.exit(1); });
