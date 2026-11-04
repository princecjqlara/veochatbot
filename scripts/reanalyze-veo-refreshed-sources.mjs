// Rebuild older saved refresh artifacts with the current deterministic local
// evidence parser. This reads saved source archives only; it makes no API/AI calls.
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module'; import { gunzipSync, gzipSync } from 'node:zlib';
import { build } from 'esbuild'; import { digest } from './lib/database-migration-safety.mjs';

const dir=path.resolve('.vercel/veo-backlog/refreshed');
const runtime=path.join(path.resolve('.vercel/veo-backlog'),'analysis-runtime.cjs');
await build({entryPoints:['src/lib/contact-backlog-analysis.ts'],outfile:runtime,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {analyzeContactBacklog,verifyBacklogArtifact,BACKLOG_ANALYSIS_VERSION}=createRequire(import.meta.url)(runtime);
const reset=path.resolve('.vercel/veo-reset/chatbot_configs.jsonl.gz');
const configs=new Map();
for(const line of gunzipSync(fs.readFileSync(reset)).toString('utf8').split('\n').filter(Boolean)){
 const row=JSON.parse(line);configs.set(row.page_id,{requestedFields:Array.isArray(row.details_to_collect)?row.details_to_collect.filter(x=>typeof x==='string'):[],commercialVideo:row.commercial_video_intake_enabled===true});
}
const files=fs.readdirSync(dir).filter(name=>name.endsWith('.profile.json.gz'));
const report={engine:BACKLOG_ANALYSIS_VERSION,sources:files.length,rebuilt:0,already_current:0,errors:[]};
for(const name of files){try{
 const file=path.join(dir,name),compressed=fs.readFileSync(file),old=JSON.parse(gunzipSync(compressed).toString('utf8'));
 if(old.engine===BACKLOG_ANALYSIS_VERSION&&old.model===BACKLOG_ANALYSIS_VERSION){verifyBacklogArtifact(old);report.already_current++;continue;}
 const checkout=path.resolve('.'),sourceFile=path.resolve('..',old.source_archive);
 if(!sourceFile.startsWith(checkout+path.sep))throw Error('Source escaped checkout');
 const bytes=fs.readFileSync(sourceFile),sourceText=(sourceFile.endsWith('.gz')?gunzipSync(bytes).toString('utf8'):bytes.toString('utf8')).replace(/^\uFEFF/,'');
 if(digest(sourceText)!==old.source_sha256)throw Error('Saved source fingerprint changed');
 const source=JSON.parse(sourceText);
 if(source.complete!==true||source.page_id!==old.page_id||source.facebook_page_id!==old.facebook_page_id||source.psid!==old.psid||!Array.isArray(source.messages))throw Error('Saved source identity/integrity failed');
 const analysis=analyzeContactBacklog({pageId:source.page_id,facebookPageId:source.facebook_page_id,psid:source.psid,cutoff:source.source_cutoff_at,messages:source.messages,...(configs.get(source.page_id)||{})});
 const fresh={...analysis,engine:BACKLOG_ANALYSIS_VERSION,page_id:source.page_id,facebook_page_id:source.facebook_page_id,psid:source.psid,prepared_at:new Date().toISOString(),processing_complete:true,source_sha256:old.source_sha256,source_cutoff_at:source.source_cutoff_at,source_kind:old.source_kind,source_archive:old.source_archive};
 verifyBacklogArtifact(fresh);fs.writeFileSync(file,gzipSync(JSON.stringify(fresh)));report.rebuilt++;
 if((report.rebuilt+report.already_current)%500===0)console.log(JSON.stringify({processed:report.rebuilt+report.already_current,total:files.length,rebuilt:report.rebuilt}));
 }catch(error){report.errors.push({file:name,error:error.message});}}
console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
