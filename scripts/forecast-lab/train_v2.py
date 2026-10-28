"""Chronological candidate development. Never select candidates on final replay.

Poisson person-period likelihood: y=event/exposure, weight=exposure.
The objective is proportional to exposure*rate-event*log(rate); censoring
contributes observed exposure only. All message features freeze at landmarks.
"""
import os
os.environ.setdefault('OMP_NUM_THREADS','2')
os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
import json,math,sys,time,hashlib,pickle,argparse,statistics,collections
from pathlib import Path
from datetime import datetime,timezone
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'conversion-forecast-prototype'))
import model as legacy
HOUR=legacy.HOUR;EDGES=np.array(legacy.EDGES,dtype=float);LANDMARKS=legacy.LANDMARKS
DATA=ROOT/'data/conversion-forecast-prototype';OUT=ROOT/'outputs/conversion-forecast-v2';OUT.mkdir(exist_ok=True,parents=True)
PAGES=['Azshinari','SAMA KANA MEDIA','Vista Media Agency','Manawari Studios','Loki Media']
STATES=['initial_inquiry','active_conversation','duration_chosen','returned_later','replied_after_quote','form_details']
NUMERIC=['log_inbound','quoted','form','duration','returned','price_question','log_recency_hours','first_hour_sin','first_hour_cos','first_dow_sin','first_dow_cos','log_landmark','log_interval_start','log_interval_width']
def log(stage,**kw):print(json.dumps(dict(stage=stage,**kw)),flush=True)
def read_records():
 records=[]
 with (DATA/'features.jsonl').open(encoding='utf8') as source:
  for line in source:
   r=json.loads(line)
   legacy.validate_record(r,r['observed'])
   records.append({k:r[k] for k in ['id','page','first','event','observed','snapshots']})
 assert len(records)==len({r['id'] for r in records})
 return records
def schema(records,cutoff):
 industries=sorted({s['i'] for r in records if r['first']<cutoff for s in r['snapshots'] if s['h']*HOUR+r['first']<cutoff})
 return dict(pages=PAGES,states=STATES,industries=industries,numeric=NUMERIC,feature_names=NUMERIC+['page:'+p for p in PAGES]+['state:'+s for s in STATES]+['industry:'+s for s in industries])
def vector(r,f,j,sc):
 hour=((r['first']/HOUR)+8)%24;dow=datetime.fromtimestamp((r['first']+8*HOUR)/1000,timezone.utc).weekday()
 last=f.get('last_inbound_h');recency=f['h']-last if last is not None else f['h']
 return [math.log1p(max(0,f.get('inbound',1))),*[int(bool(f.get(k))) for k in ['quoted','form','duration','returned','price_question']],math.log1p(max(0,recency)),math.sin(2*math.pi*hour/24),math.cos(2*math.pi*hour/24),math.sin(2*math.pi*dow/7),math.cos(2*math.pi*dow/7),math.log1p(f['h']),math.log1p(EDGES[j]),math.log1p(EDGES[j+1]-EDGES[j]),*[int(r['page']==p) for p in sc['pages']],*[int(f['b']==s) for s in sc['states']],*[int(f['i']==i) for i in sc['industries']]]
def periods(records,cutoff,sc,half_life=0):
 xs=[];ys=[];weights=[];events=0
 for r in records:
  if r['first']>=cutoff:continue
  obs=(min(r['observed'],cutoff)-r['first'])/HOUR
  event=(r['event']-r['first'])/HOUR if r['event'] is not None and r['event']<=cutoff else math.inf
  rw=2**(-max(0,cutoff-r['first'])/(half_life*24*HOUR)) if half_life else 1
  for f in r['snapshots']:
   if f['h']>=obs or event<=f['h']:continue
   for j,(a,b) in enumerate(zip(EDGES,EDGES[1:])):
    if a<f['h']:continue
    exposure=min(obs,event,b)-a
    if exposure<=0:continue
    y=int(a<event<=b and event<=obs)
    xs.append(vector(r,f,j,sc));ys.append(y/exposure);weights.append(exposure*rw);events+=y
 return np.array(xs,dtype=np.float32),np.array(ys),np.array(weights),events
def export_boost(estimator,sc):
 trees=[]
 for ensemble in estimator._predictors:
  tree=ensemble[0];nodes=[]
  for n in tree.nodes:
   assert not n['is_categorical']
   nodes.append([int(n['feature_idx']),float(n['num_threshold']),int(n['left']),int(n['right']),float(n['value']),int(n['is_leaf']),int(n['missing_go_to_left'])])
  trees.append(nodes)
 return dict(schema_version=2,method='Landmark piecewise-exponential boosted Poisson survival',schema=sc,edges_hours=EDGES.tolist(),checkpoints_hours=LANDMARKS,base_log_rate=float(estimator._baseline_prediction[0,0]),trees=trees)
def predict_export(m,x):
 x=[float(np.float32(v)) for v in x]
 raw=m['base_log_rate']
 for nodes in m['trees']:
  ix=0
  while not nodes[ix][5]:
   feature,threshold,left,right,_,_,missing=nodes[ix];v=x[feature];ix=(left if missing else right) if v is None or math.isnan(v) else (left if v<=threshold else right)
  raw+=nodes[ix][4]
 return math.exp(min(20,max(-30,raw)))
def rates_batch(est,sc,records,l,start,end,horizon):
 eligible=[];xs=[]
 for r in records:
  if not start<=r['first']<end or r['observed']<r['first']+horizon*HOUR:continue
  e=(r['event']-r['first'])/HOUR if r['event'] is not None else math.inf
  if e<=l:continue
  f=legacy.snapshot_at(r,l)
  if f is None:continue
  eligible.append((r,e))
  xs.extend(vector(r,f,j,sc) for j in range(len(EDGES)-1))
 if not eligible:return [],np.empty((0,len(EDGES)-1))
 return eligible,est.predict(np.array(xs,dtype=np.float32)).reshape(len(eligible),len(EDGES)-1)
def timing(rs,age,horizon):
 total=-math.expm1(-min(700,legacy.integrate(rs,age,horizon)))
 def q(prob):
  target=-math.log1p(-prob*total);lo=age;hi=horizon
  for _ in range(35):
   mid=(lo+hi)/2
   if legacy.integrate(rs,age,mid)<target:lo=mid
   else:hi=mid
  return ((lo+hi)/2-age)/24
 return [q(.1),q(.25),q(.5),q(.75),q(.9)]
def evaluate_boost(est,sc,records,start,end,landmarks=(0,24,72),horizons=(168,336,720),factor=1,include_rows=False,timing_calibration=None):
 result={};rows=[]
 for h in horizons:
  result[str(h)]={}
  for l in landmarks:
   if l>=h:continue
   eligible,rates=rates_batch(est,sc,records,l,start,end,h);samples=[];times=[]
   for (r,e),rs in zip(eligible,rates):
    rs=rs*factor;p=-math.expm1(-min(700,legacy.integrate(rs,l,h)));y=int(e<=h);samples.append((y,p))
    row=dict(id=r['id'],page=r['page'],first=r['first'],landmark=l,horizon=h,label=y,probability=p)
    if y:
     q=timing(rs,l,h);actual=(e-l)/24;correction=(timing_calibration or {}).get(str(h)+':'+str(l),{}).get('margin_days',0);q[0]=max(0,q[0]-correction);q[4]=min((h-l)/24,q[4]+correction);times.append(dict(error=abs(q[2]-actual),actual=actual,q=q));row.update(actual_days=actual,predicted_days=q[2],q=q)
    if include_rows:rows.append(row)
   metric=legacy.metrics(samples)
   metric['timing']=timing_metrics(times)
   result[str(h)][str(l)]=metric
 return result,rows
def timing_metrics(times):
 return dict(n=len(times),mae_days=statistics.mean(t['error'] for t in times) if times else None,median_error_days=statistics.median(t['error'] for t in times) if times else None,within_1_day=sum(t['error']<=1 for t in times)/len(times) if times else None,within_3_days=sum(t['error']<=3 for t in times)/len(times) if times else None,central50_coverage=sum(t['q'][1]<=t['actual']<=t['q'][3] for t in times)/len(times) if times else None,central80_coverage=sum(t['q'][0]<=t['actual']<=t['q'][4] for t in times)/len(times) if times else None)
def evaluate_legacy(m,records,start,end,landmarks=(0,24,72),horizons=(168,336,720),include_rows=False):
 result={};rows=[]
 for h in horizons:
  result[str(h)]={}
  for l in landmarks:
   if l>=h:continue
   samples=[];times=[]
   for r in records:
    if not start<=r['first']<end or r['observed']<r['first']+h*HOUR:continue
    e=(r['event']-r['first'])/HOUR if r['event'] is not None else math.inf
    if e<=l:continue
    f=legacy.forecast(m,r,r['first']+l*HOUR,h);p=f['probability']
    if p is None:continue
    y=int(e<=h);samples.append((y,p));row=dict(id=r['id'],page=r['page'],first=r['first'],landmark=l,horizon=h,label=y,probability=p)
    if y:
     rs,_=legacy.rates(m,r,legacy.snapshot_at(r,l));q=timing(rs,l,h);actual=(e-l)/24;times.append(dict(error=abs(q[2]-actual),actual=actual,q=q));row.update(actual_days=actual,predicted_days=q[2],q=q)
    if include_rows:rows.append(row)
   metric=legacy.metrics(samples);metric['timing']=timing_metrics(times);result[str(h)][str(l)]=metric
 return result,rows
def score(results):
 # Equal horizon/checkpoint weight avoids early large cohorts dominating.
 return statistics.mean(m['log_loss'] for fold in results for h in fold.values() for m in h.values() if m['n'])
def compact(result):return {h:{l:{k:m.get(k) for k in ['n','events','log_loss','brier','auc','mean_predicted','actual_rate','timing']} for l,m in levels.items()} for h,levels in result.items()}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--stage',choices=['develop','calibrate','test','final'],default='develop');a=ap.parse_args()
 records=read_records();monthly=collections.defaultdict(lambda:[0,0])
 for r in records:monthly[legacy.pht(r['first'])[:7]][0]+=1;monthly[legacy.pht(r['first'])[:7]][1]+=r['event'] is not None
 log('loaded',records=len(records),monthly=dict(sorted(monthly.items())))
 if a.stage=='develop':
  # Development outcomes all mature before September 15. Final Sept/Oct replay
  # must remain unopened until the candidate and its parameters are locked.
  folds=[('2026-07-01','2026-07-15'),('2026-08-01','2026-08-15')]
  candidates=[dict(name='boost-small',leaves=7,iterations=100,l2=1,half_life=0),dict(name='boost-regularized',leaves=7,iterations=160,l2=5,half_life=0),dict(name='boost-deeper',leaves=15,iterations=120,l2=5,half_life=0),dict(name='boost-recent',leaves=7,iterations=120,l2=5,half_life=90)]
  reports=[]
  for c in candidates:
   results=[]
   for start,end in folds:
    cutoff=legacy.parse_pht(start+' 00:00:00');stop=legacy.parse_pht(end+' 00:00:00');sc=schema(records,cutoff);stamp=time.time();X,y,w,n=periods(records,cutoff,sc,c['half_life']);log('training',candidate=c['name'],fold=start,rows=len(y),expanded_events=n,features=X.shape[1])
    est=HistGradientBoostingRegressor(loss='poisson',learning_rate=.06,max_iter=c['iterations'],max_leaf_nodes=c['leaves'],min_samples_leaf=150,l2_regularization=c['l2'],early_stopping=False,max_bins=64,random_state=2901).fit(X,y,sample_weight=w)
    del X,y,w
    result,_=evaluate_boost(est,sc,records,cutoff,stop,landmarks=(0,24,72));results.append(result);log('development_result',candidate=c['name'],fold=start,seconds=round(time.time()-stamp,1),metrics=compact(result))
   reports.append(dict(parameters=c,score=score(results),folds=results))
   (OUT/'development-partial.json').write_text(json.dumps(reports,indent=2))
  baseline=[]
  for start,end in folds:
   cutoff=legacy.parse_pht(start+' 00:00:00');m=legacy.fit(records,cutoff,200,'full',1.25);result,_=evaluate_legacy(m,records,cutoff,legacy.parse_pht(end+' 00:00:00'));baseline.append(result)
  reports.sort(key=lambda c:c['score']);chosen=reports[0]
  decision=dict(development_folds=folds,selection_metric='Equal horizon/checkpoint average out-of-period log loss',candidates=reports,legacy_development_score=score(baseline),legacy_development=baseline,chosen=chosen['parameters'],final_replay_not_used_for_selection=True)
  (OUT/'selection.json').write_text(json.dumps(decision,indent=2));log('candidate_locked',chosen=chosen['parameters'],candidate_score=chosen['score'],legacy_score=score(baseline))
 elif a.stage=='calibrate':
  decision=json.loads((OUT/'selection.json').read_text());c=decision['chosen'];cells=[];calibration_models=[]
  for start,end in decision['development_folds']:
   cutoff=legacy.parse_pht(start+' 00:00:00');sc=schema(records,cutoff);X,y,w,_=periods(records,cutoff,sc,c['half_life'])
   est=HistGradientBoostingRegressor(loss='poisson',learning_rate=.06,max_iter=c['iterations'],max_leaf_nodes=c['leaves'],min_samples_leaf=150,l2_regularization=c['l2'],early_stopping=False,max_bins=64,random_state=2901).fit(X,y,sample_weight=w);del X,y,w
   _,rows=evaluate_boost(est,sc,records,cutoff,legacy.parse_pht(end+' 00:00:00'),include_rows=True)
   calibration_models.append((est,sc,cutoff,legacy.parse_pht(end+' 00:00:00')))
   for h in [168,336,720]:
    for l in [0,24,72]:
     group=[r for r in rows if r['horizon']==h and r['landmark']==l];cells.append((np.array([r['label'] for r in group]),np.array([r['probability'] for r in group])))
   log('calibration_predictions',fold=start,rows=len(rows))
  choices=[]
  for factor in [.5,.75,1,1.25,1.5,1.75,2,2.5]:
   losses=[]
   for ys,ps in cells:
    calibrated=np.clip(-np.expm1(factor*np.log1p(-np.minimum(ps,1-1e-12))),1e-10,1-1e-10);losses.append(float(np.mean(-ys*np.log(calibrated)-(1-ys)*np.log1p(-calibrated))))
   choices.append(dict(hazard_factor=factor,score=statistics.mean(losses)))
  choices.sort(key=lambda r:r['score']);decision['chosen']['hazard_factor']=choices[0]['hazard_factor'];decision['calibration_candidates']=choices
  all_calibration=[]
  for est,sc,start,end in calibration_models:
   _,rows=evaluate_boost(est,sc,records,start,end,landmarks=LANDMARKS,include_rows=True,factor=choices[0]['hazard_factor']);all_calibration.extend(rows)
  correction={}
  for h in [168,336,720]:
   for l in LANDMARKS:
    g=[r for r in all_calibration if r['label'] and r['horizon']==h and r['landmark']==l]
    if len(g)>=30:
     residual=sorted(max(r['q'][0]-r['actual_days'],r['actual_days']-r['q'][4]) for r in g);ix=min(len(g)-1,math.ceil((len(g)+1)*.8)-1);correction[str(h)+':'+str(l)]=dict(n=len(g),margin_days=max(0,residual[ix]),nominal_coverage=.8)
  decision['timing_calibration']=correction;decision['parameters_locked_at_utc']=datetime.now(timezone.utc).isoformat();(OUT/'selection.json').write_text(json.dumps(decision,indent=2));log('calibration_locked',chosen=decision['chosen'],score=choices[0]['score'],timing_calibration=correction)
 else:
  decision=json.loads((OUT/'selection.json').read_text());c=decision['chosen'];starts=['2026-09-15','2026-09-22','2026-09-29','2026-10-06','2026-10-13'] if a.stage=='test' else [legacy.pht(records[0]['observed'])[:10]]
  if a.stage=='test':assert max(legacy.parse_pht(end+' 00:00:00') for _,end in decision['development_folds'])+30*24*HOUR<=legacy.parse_pht(starts[0]+' 00:00:00')
  results=[];all_rows=[]
  for start in starts:
   cutoff=legacy.parse_pht(start+' 00:00:00') if a.stage=='test' else records[0]['observed'];end=cutoff+7*24*HOUR;sc=schema(records,cutoff);X,y,w,n=periods(records,cutoff,sc,c['half_life']);log('training_locked',fold=start,rows=len(y))
   est=HistGradientBoostingRegressor(loss='poisson',learning_rate=.06,max_iter=c['iterations'],max_leaf_nodes=c['leaves'],min_samples_leaf=150,l2_regularization=c['l2'],early_stopping=False,max_bins=64,random_state=2901).fit(X,y,sample_weight=w);del X,y,w
   exported=export_boost(est,sc)
   # Validate model serialization against the library on distinct synthetic inputs.
   for r in records[::173]:
    if not r['snapshots']:continue
    x=vector(r,r['snapshots'][0],0,sc);actual=est.predict(np.array([x],dtype=np.float32))[0];assert math.isclose(predict_export(exported,x),actual,rel_tol=1e-6,abs_tol=1e-9)
   if a.stage=='final':
    support={}
    for r in records:
     if r['observed']-r['first']<720*HOUR:continue
     event_age=(r['event']-r['first'])/HOUR if r['event'] is not None else math.inf
     for f in r['snapshots']:
      if event_age<=f['h']:continue
      for group in [[f['h'],r['page']],[f['h'],r['page'],f['b']],[f['h'],r['page'],f['b'],f['i']]]:
       k=json.dumps(group,separators=(',',':'));v=support.setdefault(k,[0,0]);v[0]+=1;v[1]+=event_age<=720
    exported.update(hazard_factor=c.get('hazard_factor',1),timing_calibration=decision.get('timing_calibration',{}),support=support,training_cutoff_ms=cutoff,training_cutoff_pht=legacy.pht(cutoff),records_used=len(records),parameters=c,validation=decision['chosen']);exported['version']=hashlib.sha256(json.dumps(exported,sort_keys=True).encode()).hexdigest()[:16];(OUT/'candidate-model.json').write_text(json.dumps(exported,separators=(',',':')));log('exported',version=exported['version'],trees=len(exported['trees']));continue
   proposed,rows=evaluate_boost(est,sc,records,cutoff,end,landmarks=LANDMARKS,include_rows=True,factor=c.get('hazard_factor',1),timing_calibration=decision.get('timing_calibration'));base=legacy.fit(records,cutoff,200,'full',1.25);current,old_rows=evaluate_legacy(base,records,cutoff,end,landmarks=LANDMARKS,include_rows=True)
   for model_name,g in [('candidate',rows),('current',old_rows)]:all_rows.extend(dict(model=model_name,fold=start,**row) for row in g)
   results.append(dict(fold=start,candidate=proposed,current=current));(OUT/'replay-partial.json').write_text(json.dumps(results,indent=2));log('replay',fold=start,candidate=compact(proposed),current=compact(current))
  if a.stage=='test':
   (OUT/'replay.json').write_text(json.dumps(dict(selection_sha256=hashlib.sha256((OUT/'selection.json').read_bytes()).hexdigest(),folds=results),indent=2));(OUT/'replay-rows.jsonl').write_text('\n'.join(json.dumps(r) for r in all_rows)+'\n');log('replay_saved',folds=len(results),rows=len(all_rows))
if __name__=='__main__':main()
