// Package the already-validated model and identical source-feature rules; no training.
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),workspace=path.resolve(root,'..'),out=path.join(root,'src/lib/conversion-runtime');
fs.mkdirSync(out,{recursive:true});
const read=p=>fs.readFileSync(path.join(workspace,p),'utf8');
const model=JSON.parse(read('outputs/conversion-forecast-prototype/model.json'));
if(model.version!=='eddb1b3d6b59c75e')throw Error('Review and validate a replacement model before packaging it');
fs.writeFileSync(path.join(out,'model.json'),JSON.stringify(model));
for(const[from,to]of[['industry_taxonomy.mjs','taxonomy.js'],['conversion_helpers.mjs','evidence.js']])fs.writeFileSync(path.join(out,to),read('data/industry-conversion-2026-10-24/'+from));
const audited=read('data/industry-conversion-2026-10-24/extract_customer_records.mjs'),features=read('conversion-forecast-prototype/features.mjs');
const defs=audited.slice(audited.indexOf('const genericClient='),audited.indexOf('const sha='));
const loop=audited.slice(audited.indexOf(' const candidates=[];let incoming=0;'),audited.indexOf(' const lifetimeIndustry=classifyIndustry'));
const runtime=`// Generated from the timestamp-safe, backtested historical extractor.\nimport{industryMatches,classifyIndustry}from'./taxonomy.js';\nimport{administrative}from'./evidence.js';\nexport const CHECKPOINTS=[0,1,6,24,72,168,336];\nexport const UNKNOWN='Unknown / insufficient business detail';\nfunction candidatesFrom(seq,industryMatches,DAY){\n${defs}${loop}\nreturn candidates;\n}\n`+features.slice(features.indexOf('const priceQ='));
fs.writeFileSync(path.join(out,'features.js'),runtime);
console.log(JSON.stringify({packaged:true,model_version:model.version,model_bytes:fs.statSync(path.join(out,'model.json')).size,customer_records_embedded:0,feature_rules:'Same audited checkpoint extractor; static code, no runtime evaluation'}));
