"""Synthetic cross-language calculation fixtures; contains no customer records."""
import sys,json
from pathlib import Path
root=Path(__file__).resolve().parent.parent;workspace=root.parent
sys.path.insert(0,str(workspace/'conversion-forecast-prototype'))
from model import forecast,close_window,HOUR,LANDMARKS
model=json.loads((workspace/'outputs/conversion-forecast-prototype/model.json').read_text(encoding='utf8'));cut=model['training_cutoff_ms'];cases=[]
for page in ['Azshinari','SAMA KANA MEDIA']:
 for age in [0,.5,1.5,25,73,170,340,750]:
  for behavior in ['initial_inquiry','form_details','replied_after_quote']:
   first=cut-age*HOUR;snaps=[dict(h=h,i='Unknown / insufficient business detail',s='Unknown',b=behavior) for h in LANDMARKS if h<=age];r=dict(page=page,first=first,event=None,snapshots=snaps)
   cases.append(dict(page=page,cache=dict(contact_id='synthetic',page_id='synthetic',first_inquiry_at=__import__('datetime').datetime.fromtimestamp(first/1000,__import__('datetime').timezone.utc).isoformat(),source_cutoff_at=__import__('datetime').datetime.fromtimestamp(cut/1000,__import__('datetime').timezone.utc).isoformat(),snapshots=snaps,payment_at=None,payment_evidence_id=None,source_kind='audited_history',complete_history=True,dirty_at=None),expected={str(h):forecast(model,r,cut,h)['probability'] for h in [168,336,720]},timing=close_window(model,r,cut)))
path=root/'src/lib/__tests__/contact-forecast-golden.json';path.write_text(json.dumps(cases,separators=(',',':')),encoding='utf8');print(json.dumps(dict(synthetic_cases=len(cases),path=str(path))))
