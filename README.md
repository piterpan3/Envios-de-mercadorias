# BENGA ENVIOS — site + servidor

Transporte aéreo de mercadorias **Angola ↔ Portugal**. Um único programa Node.js (sem instalar nada com `npm`) que serve o site e guarda os dados: contas, encomendas, rastreio, avaliações e suporte.

## 1. Arrancar no seu computador (para ver)

Precisa do [Node.js](https://nodejs.org) 18 ou superior.

```bash
cp .env.example .env        # abra o .env e escreva a ADMIN_PASSWORD (mín. 10 caracteres)
node server.js
```

Abra http://localhost:3000 e entre em **ENTRAR** com o `ADMIN_EMAIL` e a `ADMIN_PASSWORD`. A conta de administrador é criada na primeira execução; depois pode mudar a palavra-passe no painel (Definições do administrador).

## 2. Publicar (precisa de um alojamento com disco persistente)

O site grava os dados em ficheiros (`DATA_DIR`). Por isso o alojamento tem de ter **disco que não se apaga** — caso contrário os clientes e encomendas perdem-se a cada reinício. Serviços grátis com disco temporário **não servem**.

**Opção A — Render / Railway / Fly (mais simples):** crie um *Web Service* a partir deste projeto, comando de arranque `node server.js`, adicione um **disco persistente** (ex.: montado em `/var/data`) e defina as variáveis: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DATA_DIR=/var/data`, `TRUST_PROXY=1`. O HTTPS vem incluído.

**Opção B — Docker:** `docker build -t benga . && docker run -d -p 3000:3000 -v benga-data:/data -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... benga` e ponha um proxy HTTPS à frente (Caddy/Nginx).

**Opção C — servidor (VPS):** `node server.js` com `pm2` ou `systemd`, e Caddy/Nginx a fazer o HTTPS para a porta 3000, com `TRUST_PROXY=1`.

Depois de publicar, aponte o seu domínio para o serviço. **Use sempre HTTPS** (o cookie de sessão só é seguro assim).
Execute **apenas uma instância** do servidor.

## 3. Antes de abrir ao público (checklist)

1. **Painel admin → Configurações da Benga → Contactos:** WhatsApp oficial (com indicativo, ex.: `244…` ou `351…`) — sem isto o botão "Abrir WhatsApp" não aparece no pedido do cliente. Preencha também telefone, horário e NIF.
2. **Preços e taxas / Entregas / Moradas:** confirme o preço por kg, as taxas de entrega e as duas moradas.
3. **Pagamentos:** já vem preenchido com as contas de transferência (titular Rachid Gomes: conta de Portugal e conta de Angola). Confirme-as em *Configurações → Pagamentos*; o cliente só as vê na página *Pagamentos* depois de a encomenda ser aprovada (nunca no site público).
4. **Números do site:** deixe 0 se não tiver histórico; a faixa de números só aparece quando houver valores (são somados às encomendas entregues).
5. **Política de privacidade e Termos** (`#/privacidade`, `#/termos`): são textos-base. Peça a um profissional para os rever e adaptar à vossa situação (RGPD, NIF, responsabilidade no transporte).
6. Faça uma encomenda de teste com uma conta de cliente, aprove-a e siga-a até "Entregue" (depois apague os dados de teste ou crie a conta do cliente de teste e bloqueie-a).

## 4. Login com Google (opcional)

1. Em https://console.cloud.google.com → *APIs e serviços → Credenciais → Criar credenciais → ID de cliente OAuth* (tipo **Aplicação Web**).
2. Em *Origens JavaScript autorizadas* ponha o endereço do site (ex.: `https://www.bengaenvios.com`).
3. Copie o ID de cliente para a variável `GOOGLE_CLIENT_ID` e reinicie. O botão "Continuar com Google" aparece sozinho.

O servidor verifica o token junto da Google; contas da equipa (admin/funcionário) nunca entram por Google. Microsoft e Facebook não estão incluídos (precisam de configuração própria).

## 5. Dia a dia

- **Cópias de segurança:** o servidor cria uma por dia em `DATA_DIR/backups/` (guarda 30). Descarregue-as com regularidade para fora do servidor.
- **Esqueceu-se da palavra-passe do admin:** pare o servidor e execute `node reset-admin.js email "nova-palavra-passe"`.
- **Cliente esqueceu-se da palavra-passe:** Painel → Clientes → *Repor senha* (gera uma temporária para enviar por WhatsApp).
- **Notificações:** são dentro da conta (sino) e por WhatsApp (link pré-preenchido). O sistema **não envia e-mails**.
- **Mensagens de suporte** dos clientes aparecem em *Mensagens de suporte* no painel.

## 6. Segurança incluída

Palavras-passe com `scrypt` + sal · sessões por cookie `HttpOnly` (7 dias) · limite de tentativas de login, registo e rastreio · verificação de origem (anti-CSRF) · cabeçalhos CSP/HSTS/nosniff · texto sempre escapado (anti-XSS) · todas as permissões verificadas no servidor · auditoria das ações do painel.

## 7. Limites a conhecer

Os dados ficam num ficheiro JSON: ótimo para um negócio pequeno/médio (centenas a alguns milhares de encomendas). Se crescer muito, migre para uma base de dados (PostgreSQL). Não há envio de e-mails nem pagamento online.

## 8. Testes

```bash
node test/api.test.js          # 103 verificações da API (permissões, segurança, persistência, Google simulado)
python3 test/e2e.py            # percurso completo no navegador (precisa de playwright)
```
