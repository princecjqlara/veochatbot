"""Paired audit, calendar-day block bootstrap, and predeclared release gates."""
import sys,json,math,statistics,collections,hashlib
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'conversion-forecast-prototype'));import model as old
OUT=ROOT/'outputs/conversion-forecast-v2'
def mean(xs):return statistics.mean(xs) if xs else None
def metric(rows):
 result=old.metrics([(r['label'],r['probability']) for r in rows]);payers=[r for r in rows if r['label']]
 result['timing']={'n':len(payers),'mae_days':mean([abs(r['predicted_days']-r['actual_days']) for r in payers]),'median_error_days':statistics.median(abs(r['predicted_days']-r['actual_days']) for r in payers) if payers else None,'within_1_day':mean([abs(r['predicted_days']-r['actual_days'])<=1 for r in payers]),'within_3_days':mean([abs(r['predicted_days']-r['actual_days'])<=3 for r in payers]),'central80_coverage':mean([r['q'][0]<=r['actual_days']<=r['q'][4] for r in payers]),'central50_coverage':mean([r['q'][1]<=r['actual_days']<=r['q'][3] for r in payers])}
 return result
def error(r,kind):
 p=min(1-1e-10,max(1e-10,r['probability']));y=r['label']
 return (p-y)**2 if kind=='brier' else -y*math.log(p)-(1-y)*math.log1p(-p) if kind=='log_loss' else abs(r['predicted_days']-r['actual_days'])
def paired_bootstrap(pairs,kind,iterations=2000):
 day_groups=collections.defaultdict(list)
 for a,b in pairs:
  if kind=='timing' and not a['label']:continue
  day_groups[old.day(a['first'])].append((a,b))
 summaries=[(sum(error(a,kind) for a,b in g),sum(error(b,kind) for a,b in g),len(g)) for g in day_groups.values()]
 if not summaries:return None
 xs=np.array(summaries);rng=np.random.default_rng(281026);ix=rng.integers(0,len(xs),(iterations,len(xs)));total=xs[ix].sum(axis=1);delta=(total[:,1]-total[:,0])/total[:,2]
 return {'unit':'Philippine first-inquiry calendar day','days':len(xs),'replicates':iterations,'candidate_minus_current':float((xs[:,1].sum()-xs[:,0].sum())/xs[:,2].sum()),'difference_95_interval':np.quantile(delta,[.025,.975]).tolist()}
def main():
 selection=json.loads((OUT/'selection.json').read_text());replay=json.loads((OUT/'replay.json').read_text());assert replay['selection_sha256']==hashlib.sha256((OUT/'selection.json').read_bytes()).hexdigest(),'Parameters changed after replay'
 rows=[json.loads(x) for x in (OUT/'replay-rows.jsonl').read_text().splitlines()];current={(r['id'],r['fold'],r['landmark'],r['horizon']):r for r in rows if r['model']=='current'};proposed={(r['id'],r['fold'],r['landmark'],r['horizon']):r for r in rows if r['model']=='candidate'};assert current.keys()==proposed.keys()
 pairs=[(a,proposed[k]) for k,a in current.items()];assert all(a['label']==b['label'] for a,b in pairs)
 comparison={}
 for h in [168,336,720]:
  comparison[str(h)]={}
  for l in old.LANDMARKS:
   g=[(a,b) for a,b in pairs if a['horizon']==h and a['landmark']==l]
   if not g:continue
   first=metric([a for a,b in g]);second=metric([b for a,b in g]);comparison[str(h)][str(l)]={'current':first,'candidate':second,'paired_brier':paired_bootstrap(g,'brier'),'paired_log_loss':paired_bootstrap(g,'log_loss'),'paired_timing':paired_bootstrap(g,'timing')}
 cells=[cell for h in comparison.values() for cell in h.values()];aggregate={model:{k:mean([c[model][k] for c in cells]) for k in ['log_loss','brier']} for model in ['current','candidate']}
 loss_improvement=1-aggregate['candidate']['log_loss']/aggregate['current']['log_loss'];brier_improvement=1-aggregate['candidate']['brier']/aggregate['current']['brier'];focus=comparison['720']['24'];auc_delta=focus['candidate']['auc']-focus['current']['auc'];timing_improvement=1-focus['candidate']['timing']['mae_days']/focus['current']['timing']['mae_days']
 gates={'log_loss_at_least_2pct_better':loss_improvement>=.02,'brier_no_worse':brier_improvement>=0,'day30_at24_auc_not_down_over_002':auc_delta>=-.02,'day30_at24_timing_mae_not_worse':timing_improvement>=0}
 pages={}
 for page in sorted({a['page'] for a,b in pairs}):
  g=[(a,b) for a,b in pairs if a['page']==page and a['horizon']==720 and a['landmark']==24];pages[page]={'current':metric([a for a,b in g]),'candidate':metric([b for a,b in g])}
 decision={'release_passed':all(gates.values()),'gates':gates,'relative_log_loss_improvement':loss_improvement,'relative_brier_improvement':brier_improvement,'day30_at24_auc_delta':auc_delta,'day30_at24_timing_mae_improvement':timing_improvement,'aggregate_equal_horizon_checkpoint_metrics':aggregate}
 report={'schema_version':2,'source_cutoff_pht':'2026-10-24 18:05:59','source_records':43764,'target':'First documented payment/deposit confirmation','development':{'folds':selection['development_folds'],'chosen':selection['chosen'],'timing_interval_corrections':selection.get('timing_calibration'),'parameters_locked_at_utc':selection.get('parameters_locked_at_utc')},'final_replay_weeks':[f['fold'] for f in replay['folds']],'comparison':comparison,'pages_day30_at24':pages,'decision':decision,'unique_test_contacts':len({a['id'] for a,b in pairs}),'paired_scores':len(pairs),'notes':['No final replay outcomes used for candidate or parameter selection.','Each weekly refit sees outcomes only through its training cutoff.','Every horizon requires full elapsed observation; immature cases excluded, not counted as failures.','A contact appears at multiple landmarks/horizons; score rows are not independent customers.','Dates are conditional on confirmation by the chosen horizon, not promises.','Previously inspected September history is reused; this is historical replay, not a new prospective trial.','Day-30 timing measures every eligible later payer on identical records, without excluding difficult cases.','Bootstrap intervals use whole first-inquiry calendar days. Small samples and time drift remain.'],'method_references':['https://scikit-learn.org/1.8/modules/generated/sklearn.ensemble.HistGradientBoostingRegressor.html','https://scikit-learn.org/stable/modules/calibration.html']}
 (OUT/'backtest-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
 lines=['# Conversion forecast backtest — October 28, 2026','',f"Release gates: **{'PASS' if decision['release_passed'] else 'FAIL'}**.",'',f"Source: {report['source_records']:,} eligible Page contacts, observed through {report['source_cutoff_pht']} PHT. Target: first documented payment/deposit confirmation.",'','Models were developed on July and August cohorts, then replayed on later weekly cohorts from September 15. Each refit uses only history available before that test week. The final replay contains '+str(report['unique_test_contacts'])+' unique contacts with at least one mature horizon. Previously reviewed September history is reused; this is not a prospective accuracy claim.','',f"Equal horizon/checkpoint log loss improved {loss_improvement:.1%}; Brier error improved {brier_improvement:.1%}. These are error reductions, not the percentage of customers predicted correctly.",'','| Horizon from first inquiry | Checkpoint | Contacts still unpaid | Later confirmations | Old probability AUC | New AUC | Old timing MAE days | New timing MAE days | New within 3 days | New range coverage |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
 for h in [168,336,720]:
  for l in [0,24,72]:
   c=comparison[str(h)][str(l)];a=c['current'];b=c['candidate'];t=b['timing'];lines.append(f"| {h//24} days | {l} hours | {b['n']:,} | {b['events']} | {a['auc']:.3f} | {b['auc']:.3f} | {a['timing']['mae_days']:.2f} | {t['mae_days']:.2f} | {t['within_3_days']:.1%} | {t['central80_coverage']:.1%} |")
 lines+=['','Timing is evaluated only among contacts who later confirmed within that horizon. Probability accuracy includes both converted and unconverted contacts. Range coverage is measured on the later replay, after interval corrections were fitted on earlier development cohorts.','',f"Day-30 at 24 hours: paired timing-error difference (new minus old) = {focus['paired_timing']['candidate_minus_current']:.2f} days; 95% calendar-day bootstrap interval {focus['paired_timing']['difference_95_interval'][0]:.2f} to {focus['paired_timing']['difference_95_interval'][1]:.2f} days. Negative values favor the new formula.",'','The forecast cannot reliably promise that a particular person will buy or give an exact purchase date. Early inquiries and small groups need wider uncertainty. The probability refers to remaining confirmation by 7/14/30 days from first inquiry. A closed window is not a never-buying conclusion.','','Detailed probability calibration, all checkpoints, five-Page breakdowns, paired uncertainty and every release gate appear in backtest-report.json. No private conversation text is included in this summary.']
 (OUT/'Backtest Results.md').write_text('\n'.join(lines)+'\n',encoding='utf8');print(json.dumps({'decision':decision,'focus_day30_at24':focus,'unique_test_contacts':report['unique_test_contacts']},indent=2))
if __name__=='__main__':main()
