import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {migrationBackupLines} from './lib/migration-import.mjs';
const manifest=JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync('.vercel/database-migration/latest-account-backup.json','utf8')).manifest,'utf8'));
const directory=path.dirname(path.resolve(JSON.parse(fs.readFileSync('.vercel/database-migration/latest-account-backup.json','utf8')).manifest));
const pages=new Set(JSON.parse(fs.readFileSync('.vercel/veo-reset/retained-manifest.json','utf8')).pages.map(p=>p.id));
const item=manifest.tables.find(t=>t.name==='contacts'),hash=createHash('sha256'),index={};let scanned=0;
for await(const line of migrationBackupLines(directory,item)){hash.update(line+'\n');scanned++;const c=JSON.parse(line);if(pages.has(c.page_id))index[c.page_id+':'+c.psid]={id:c.id,name:c.name,profile_pic:c.profile_pic,chatbot_enabled:c.chatbot_enabled};}
if(scanned!==item.rows||hash.digest('hex')!==item.sha256)throw Error('Original contact archive is not intact');
fs.mkdirSync('.vercel/veo-backlog',{recursive:true});fs.writeFileSync('.vercel/veo-backlog/contact-identities.json',JSON.stringify(index));
console.log(JSON.stringify({scanned,approved_contacts:Object.keys(index).length,old_database_connections:0}));
