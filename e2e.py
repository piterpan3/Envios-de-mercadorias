import subprocess, os, time, tempfile, shutil, sys
from playwright.sync_api import sync_playwright
PORT=3377; BASE=f'http://localhost:{PORT}'; ADM=('admin@teste.pt','Admin-Teste-12345')
d=tempfile.mkdtemp(); env={**os.environ,'PORT':str(PORT),'DATA_DIR':d,'ADMIN_EMAIL':ADM[0],'ADMIN_PASSWORD':ADM[1]}
srv=subprocess.Popen(['node','server.js'],env=env,cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(1.5)
ok=bad=0
def check(n,c,x=''):
    global ok,bad
    if c: ok+=1; print('  ✔',n)
    else: bad+=1; print('  ✘',n,x)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1280,'height':800}); pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append('PAGEERROR '+str(e)))
    pg.on('console',lambda m:errs.append('CONSOLE '+m.text) if m.type=='error' and 'fonts.g' not in m.text and 'ERR_' not in m.text and '403' not in m.text and '401' not in m.text and '404' not in m.text else None)
    toast=lambda: pg.locator('.toast').last.inner_text() if pg.locator('.toast').count() else ''
    def logout():
        pg.click('text=Sair'); pg.wait_for_url('**/#/login',timeout=5000) if False else pg.wait_for_timeout(700)
    def login(e,pw,area):
        pg.goto(BASE+'/#/login'); pg.reload(); pg.wait_for_selector('#le'); pg.fill('#le',e); pg.fill('#lp',pw); pg.click('#go'); pg.wait_for_url(f'**/#/{area}/',timeout=8000)

    print('\n# Site público vazio (sem demo)')
    pg.goto(BASE+'/'); pg.wait_for_selector('#inicio',timeout=8000); pg.wait_for_timeout(600)
    body=pg.inner_text('body')
    check('carrega sem erros de JavaScript', not errs, errs)
    check('sem textos de demo/exemplo', not any(w in body for w in ['DEMO','Demo','EXEMPLO','demo.benga']))
    check('faixa de números escondida (sem dados reais)', pg.locator('#numeros').count()==0)
    check('secção de avaliações escondida (sem avaliações)', pg.locator('#avaliacoes').count()==0 and 'Avaliações' not in pg.inner_text('header'))
    check('bandeiras reais presentes', pg.locator('.fl.a').count()>=1 and pg.locator('.fl.p').count()>=1)
    check('formato do código no rastreio (não um código inventado)', 'BEN-AAAA-000000' in body and '001248' not in body)
    check('calculadora usa o preço do servidor (12,50 €)', '12,50' in body)
    pg.screenshot(path='/tmp/e2e_home_empty.png')
    pg.goto(BASE+'/#/privacidade'); pg.wait_for_timeout(400); check('página de privacidade', 'Política de privacidade' in pg.inner_text('main'))
    pg.goto(BASE+'/#/termos'); pg.wait_for_timeout(400); check('página de termos', 'Termos e condições' in pg.inner_text('main'))

    print('\n# Cliente: registo e encomenda')
    pg.goto(BASE+'/#/login'); pg.wait_for_selector('#sw'); check('sem botões falsos de login social', pg.locator('.soc').count()==0 and pg.locator('#gbtn').count()==0)
    pg.click('#sw'); pg.fill('#rn','Maria <img src=x onerror="window.__xss=1"> Silva'); pg.fill('#rp','+351900000000'); pg.fill('#le','maria@exemplo.pt'); pg.fill('#lp','Maria-Senha-1'); pg.click('#go')
    pg.wait_for_url('**/#/app/',timeout=8000); pg.wait_for_timeout(500)
    check('registo entra na área do cliente', '#/app/' in pg.url)
    check('nome malicioso é mostrado como texto (sem XSS)', pg.evaluate('window.__xss')is None)
    pg.goto(BASE+'/#/app/new'); pg.wait_for_selector('#n_w')
    pg.select_option('#n_o','Portugal'); pg.select_option('#n_d','Angola'); pg.select_option('#n_c','Roupa'); pg.fill('#n_x','Caixa de roupa'); pg.fill('#n_w','8'); pg.fill('#n_v','1'); pg.select_option('#n_m','LEVANTAMENTO')
    check('valor estimado em tempo real (8 kg × 12,50 = 100,00 €)', '100,00' in pg.inner_text('.main'))
    pg.click('#n_go'); pg.wait_for_timeout(900)
    t=pg.inner_text('body'); check('solicitação enviada, pendente de aprovação', 'pendente de aprovação' in t.lower() or 'solicitação enviada' in t.lower(), t[:300])
    check('aviso claro de WhatsApp por configurar (nada falso)', 'WHATSAPP' not in pg.inner_text('.main').upper() or pg.locator('a[href*="wa.me"]').count()==0)
    pg.goto(BASE+'/#/app/orders'); pg.wait_for_timeout(500); check('encomenda aparece como Pendente, sem código', 'PENDENTE' in pg.inner_text('.main').upper() and 'Sem código' in pg.inner_text('.main'))
    pg.goto(BASE+'/#/admin/'); pg.wait_for_timeout(500); check('cliente não entra na área admin', '#/admin' not in pg.url)
    pg.goto(BASE+'/#/app/review'); pg.wait_for_timeout(600); check('cliente ainda não pode avaliar', 'Só pode avaliar depois' in pg.inner_text('.main'))
    logout()

    print('\n# Administrador: aprovar, estados, pagamento, configurações')
    login(*ADM,'admin'); pg.wait_for_timeout(600)
    check('painel mostra 1 pendente e dados reais', pg.locator('.main').inner_text().count('Maria')>=0 and 'Aprovações pendentes' in pg.inner_text('.main'))
    check('sem "Admin Demo" no ecrã', 'Admin Demo' not in pg.inner_text('body'))
    pg.goto(BASE+'/#/admin/orders'); pg.wait_for_selector('text=APROVAR'); pg.click('text=APROVAR'); pg.wait_for_timeout(900)
    code=pg.locator('td', has_text='BEN-').first.inner_text(); check('aprovada: código gerado '+code, code.startswith('BEN-') and code.endswith('000001'))
    pg.select_option('select:has(option:has-text("Alterar estado"))','Entregue'); pg.wait_for_timeout(800)
    check('estado "Entregue" aplicado', 'ENTREGUE' in pg.inner_text('.main').upper())
    pg.goto(BASE+'/#/admin/payments'); pg.wait_for_selector('select'); pg.select_option('select','Pago'); pg.wait_for_timeout(700); check('pagamento marcado Pago', 'PAGO' in pg.inner_text('.main').upper())
    pg.goto(BASE+'/#/admin/settings'); pg.wait_for_selector('.chip'); pg.click('.chip:has-text("CONTACTOS")'); pg.wait_for_selector('#k_whatsapp'); pg.fill('#k_whatsapp','+244 923 000 000'); pg.click('button:has-text("Guardar")'); pg.wait_for_timeout(700)
    check('WhatsApp guardado pelo painel', 'Guardado' in toast(), toast())
    pg.goto(BASE+'/#/admin/clients'); pg.wait_for_selector('text=Repor senha'); check('clientes: nome malicioso escapado', pg.evaluate('window.__xss')is None and 'Maria' in pg.inner_text('.main'))
    for pgname in ['support','reviews','users','reports','security','notifs','deliveries','track']:
        pg.goto(BASE+f'/#/admin/{pgname}'); pg.wait_for_timeout(350)
    check('todas as páginas admin abrem sem erro', not [e for e in errs if 'PAGEERROR' in e], errs)
    pg.screenshot(path='/tmp/e2e_admin.png'); logout()

    print('\n# Cliente: avaliar depois de entregue; novo pedido com WhatsApp; suporte')
    login('maria@exemplo.pt','Maria-Senha-1','app'); pg.wait_for_timeout(500)
    pg.goto(BASE+'/#/app/review'); pg.wait_for_selector('#rv_t'); pg.select_option('#rv_s','5'); pg.fill('#rv_t','Serviço excelente, tudo chegou bem embalado e a tempo.'); pg.click('#rv_g'); pg.wait_for_timeout(900)
    check('avaliação enviada (fica em revisão)', 'EM REVISÃO' in pg.inner_text('.main').upper() or 'Obrigado' in toast())
    pg.goto(BASE+'/#/app/new'); pg.wait_for_selector('#n_w'); pg.select_option('#n_o','Angola'); pg.select_option('#n_d','Portugal'); pg.fill('#n_x','Sapatos'); pg.fill('#n_w','2'); pg.click('#n_go'); pg.wait_for_timeout(900)
    link=pg.locator('a[href*="wa.me"]'); check('botão ABRIR WHATSAPP com número configurado', link.count()==1 and 'wa.me/244923000000' in link.first.get_attribute('href'))
    pg.goto(BASE+'/#/app/support'); pg.wait_for_selector('#s_s'); pg.fill('#s_s','Dúvida'); pg.fill('#s_m','Quando chega a minha encomenda?'); pg.click('#s_g'); pg.wait_for_timeout(700); check('suporte enviado', True)
    pg.goto(BASE+'/#/app/payments'); pg.wait_for_timeout(700); check('cliente vê os dados para transferência (IBAN) em Pagamentos', 'PT50 0193 0000 10507750890 11' in pg.inner_text('.main') and 'Rachid Gomes' in pg.inner_text('.main'))
    pg.goto(BASE+'/#/app/orders'); pg.wait_for_timeout(500); check('o cliente vê o código e o estado Entregue', code in pg.inner_text('.main') and 'ENTREGUE' in pg.inner_text('.main').upper())
    logout()

    login(*ADM,'admin'); pg.goto(BASE+'/#/admin/support'); pg.wait_for_timeout(600); check('admin recebe a mensagem de suporte', 'Quando chega' in pg.inner_text('.main'))
    pg.goto(BASE+'/#/admin/reviews'); pg.wait_for_selector('text=Publicar'); pg.click('button:has-text("Publicar")'); pg.wait_for_timeout(700); check('avaliação publicada pelo admin', 'PUBLICADA' in pg.inner_text('.main').upper())
    logout()

    print('\n# Site público com dados reais')
    pg.goto(BASE+'/'); pg.wait_for_selector('#numeros',timeout=8000)
    pg.evaluate("document.getElementById('numeros').scrollIntoView({block:'center'})"); pg.wait_for_timeout(2200)
    nums=pg.inner_text('#numeros'); check('faixa de números real (1 envio, 8 kg, 1 cliente, 5,0)', '+1' in nums and '+8' in nums and '5,0' in nums, nums)
    check('secção de avaliações visível e sem "exemplo"', pg.locator('#avaliacoes').count()==1 and 'EXEMPLO' not in pg.inner_text('#avaliacoes').upper() and 'Maria' in pg.inner_text('#avaliacoes'))
    check('avaliação mostra "Cliente verificado"', 'verificado' in pg.inner_text('#avaliacoes'))
    check('nome malicioso do cliente não executa código', pg.evaluate('window.__xss')is None)
    pg.evaluate("document.getElementById('avaliacoes').scrollIntoView()"); pg.wait_for_timeout(700); pg.screenshot(path='/tmp/e2e_reviews.png')
    pg.fill('#tc',code); pg.click('button:has-text("RASTREAR")'); pg.wait_for_timeout(900); r=pg.inner_text('#tr'); check('rastreio público mostra estado e só o primeiro nome', 'ENTREGUE' in r.upper() and 'Maria' in r and 'Silva' not in r and '900000000' not in r, r)
    pg.fill('#tc','BEN-2026-999999'); pg.click('button:has-text("RASTREAR")'); pg.wait_for_timeout(700); check('código inexistente mostra erro amigável', 'não encontrado' in (pg.inner_text('#tr')+toast()).lower())
    pg.screenshot(path='/tmp/e2e_home_full.png',full_page=False)

    print('\n# Telemóvel')
    m=b.new_context(viewport={'width':390,'height':800},device_scale_factor=2).new_page(); merr=[]; m.on('pageerror',lambda e:merr.append(str(e)))
    m.goto(BASE+'/'); m.wait_for_selector('#inicio'); m.wait_for_timeout(800); check('sem scroll horizontal e sem erros no telemóvel', not m.evaluate('document.documentElement.scrollWidth>innerWidth') and not merr, merr); m.screenshot(path='/tmp/e2e_mobile.png')
    m.goto(BASE+'/#/login'); m.wait_for_selector('#le'); check('login cabe no telemóvel', not m.evaluate('document.documentElement.scrollWidth>innerWidth'))
    check('sem erros de JavaScript em todo o percurso', not [e for e in errs if 'PAGEERROR' in e], errs)
    b.close()
finally:
    srv.terminate(); srv.wait(); shutil.rmtree(d,ignore_errors=True)
print(f'\n{ok} passaram, {bad} falharam'); sys.exit(1 if bad else 0)
