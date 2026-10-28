"""Cross-language reference using synthetic inputs only; no customer records."""
import json,math,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent));import train_v2 as lab
out=lab.OUT;m=json.loads((out/'candidate-model.json').read_text());cases=[]
for page in lab.PAGES:
 for ix,h in enumerate(lab.LANDMARKS):
  for state_ix,b in enumerate(lab.STATES):
   first=lab.legacy.parse_pht('2026-10-01 09:13:47')+(state_ix*24+ix)*lab.HOUR
   f=dict(h=h,i=m['schema']['industries'][(ix+state_ix)%len(m['schema']['industries'])],s='Unknown',b=b,inbound=state_ix+1,quoted=state_ix>=2,form=state_ix==5,duration=state_ix==2,returned=h>=24 and state_ix>=3,price_question=state_ix%2==0,last_inbound_h=max(0,h-(state_ix*3)))
   record={'page':page,'first':first};rates=[lab.predict_export(m,lab.vector(record,f,j,m['schema']))*m['hazard_factor'] for j in range(7)]
   probabilities={str(horizon):(-math.expm1(-min(700,lab.legacy.integrate(rates,h,horizon))) if horizon>h else 0) for horizon in [168,336,720]}
   q=lab.timing(rates,h,720) if h<720 else None
   correction=m.get('timing_calibration',{}).get('720:'+str(h),{}).get('margin_days',0)
   if q:q[0]=max(0,q[0]-correction);q[4]=min((720-h)/24,q[4]+correction)
   cases.append(dict(page=page,first=first,snapshot=f,rates=rates,probabilities=probabilities,days=q))
target=lab.ROOT/'tokko-chatbot/src/lib/__tests__/contact-forecast-v2-golden.json';target.write_text(json.dumps(cases,separators=(',',':')),encoding='utf8');print(json.dumps({'synthetic_cases':len(cases),'customer_records':0}))
