import fs from 'node:fs';import {randomBytes,createHash} from 'node:crypto';import {hash,compare} from 'bcryptjs';import pg from 'pg';
import {assertProjectCredentials,VEO_RECOVERY_PROJECT} from './lib/database-migration-safety.mjs';
import {readVerifiedSetup} from './lib/veo-fresh-setup.mjs';
const {connectionString}=assertProjectCredentials(process.env,VEO_RECOVERY_PROJECT),owner='be58bd9f-059d-4368-8733-99eb8b18a371';
const receipt=JSON.parse(fs.readFileSync('.vercel/veo-fresh-start/setup-apply.json','utf8'));
if(!receipt.applied||!receipt.passed||receipt.target!==VEO_RECOVERY_PROJECT)throw Error('Verified fresh setup receipt required');
const saved=readVerifiedSetup('.vercel/veo-reset').rows.users.find(u=>u.id===owner),email=saved?.email;
if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Retained owner email unavailable');
const file='.vercel/veo-fresh-start/owner-sign-in.txt';
if(fs.existsSync(file))throw Error('Owner sign-in has already been prepared; do not overwrite credentials');
const password=randomBytes(24).toString('base64url'),prehash=createHash('sha256').update(password).digest('base64'),stored='veo-sha256:'+await hash(prehash,12);
const db=new pg.Client({connectionString,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:8000,query_timeout:8000});db.on('error',()=>{});
try{
 await db.connect();await db.query('BEGIN');const u=(await db.query("SELECT u.email,u.password_hash,u.is_active,a.role,a.active FROM users u JOIN veo_accounts a ON a.user_id=u.id JOIN veo_tenants t ON t.id=a.tenant_id AND t.owner_id=u.id WHERE u.id=$1 FOR UPDATE OF u",[owner])).rows[0];
 if(!u||u.role!=='owner'||!u.active||u.email||u.password_hash||u.is_active)throw Error('Expected restored owner with sign-in still disabled');
 await db.query('UPDATE users SET email=$1,password_hash=$2,is_active=true WHERE id=$3',[email,stored,owner]);
 const check=(await db.query('SELECT password_hash FROM users WHERE id=$1',[owner])).rows[0];if(!await compare(prehash,check.password_hash.slice(11)))throw Error('Owner password verification failed');
 fs.writeFileSync(file,`VEO recovered owner sign-in\n\nEmail: ${email}\nNew password: ${password}\n\nUse this at https://veochatbot.vercel.app after the recovery deployment.\nThe old password was unavailable. Set a new password from Profile after signing in.\nOther restored accounts need their emails/passwords configured in Accounts.\n`,{flag:'wx'});
 await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) SELECT tenant_id,$1,'owner_recovery_login',$1,jsonb_build_object('email',$2::text,'password_reset',true),'Owner requested fresh database recovery' FROM veo_accounts WHERE user_id=$1",[owner,email]);
 await db.query('COMMIT');console.log(JSON.stringify({ownerIdentityPreserved:true,loginConfigured:true,credentialsFile:file,otherAccountsUnchanged:true}));
}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{await db.end().catch(()=>{});}
