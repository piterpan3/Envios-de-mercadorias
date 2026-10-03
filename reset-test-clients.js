'use strict';
/* Remove contas/clientes e dados de teste dependentes, preservando administração, equipa e configurações. */
const fs=require('fs'),path=require('path');
const DATA_DIR=path.resolve(process.env.DATA_DIR||path.join(__dirname,'data'));
const DB=path.join(DATA_DIR,'benga.json');
if(!fs.existsSync(DB)){console.log('Nenhuma base de dados existente. Nada para remover.');process.exit(0)}
const D=JSON.parse(fs.readFileSync(DB,'utf8'));
const clients=new Set(D.users.filter(u=>u.role==='client').map(u=>u.id));
D.users=D.users.filter(u=>u.role!=='client');
D.orders=D.orders.filter(o=>!clients.has(o.user_id));
D.ev=D.ev.filter(e=>{const o=D.orders.find(x=>x.id===e.order_id);return !!o});
D.notif=D.notif.filter(n=>!clients.has(n.user_id));
D.addr=D.addr.filter(a=>!clients.has(a.user_id));
D.rev=D.rev.filter(r=>!clients.has(r.user_id));
D.support=D.support.filter(s=>!clients.has(s.user_id));
D.sessions=Object.fromEntries(Object.entries(D.sessions).filter(([,s])=>!clients.has(s.uid)));
D.seqs={};
D.nid=Math.max(1,...D.users.map(x=>x.id),...D.orders.map(x=>x.id),...D.rev.map(x=>x.id),...D.support.map(x=>x.id),...D.addr.map(x=>x.id))+1;
fs.mkdirSync(DATA_DIR,{recursive:true});
const tmp=DB+'.tmp';fs.writeFileSync(tmp,JSON.stringify(D));fs.renameSync(tmp,DB);
console.log(`Removidos ${clients.size} clientes e respetivos dados de teste.`);
