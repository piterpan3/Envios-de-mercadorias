'use strict';
/* Repor a palavra-passe de um administrador (parar o servidor antes).
   Uso:  node reset-admin.js email@exemplo.com "nova-palavra-passe-longa"      */
const fs = require('fs'), { hashPw, DB_FILE } = require('./server.js');
const [email, pw] = [(process.argv[2] || '').toLowerCase(), process.argv[3] || ''];
if (!email || pw.length < 10) { console.error('Uso: node reset-admin.js email "nova-palavra-passe (mín. 10 caracteres)"'); process.exit(1); }
const D = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')), u = D.users.find(x => x.email === email && x.role === 'admin');
if (!u) { console.error('Administrador não encontrado: ' + email); process.exit(1); }
u.pw = hashPw(pw); u.blocked = 0; for (const [k, s] of Object.entries(D.sessions)) if (s.uid === u.id) delete D.sessions[k];
fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(D)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); console.log('Palavra-passe atualizada para ' + email);
