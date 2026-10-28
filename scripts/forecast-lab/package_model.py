"""Ship only the locked candidate that passed the preregistered replay gates."""
import json,hashlib,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'outputs/conversion-forecast-v2';REPO=ROOT/'tokko-chatbot'
report=json.loads((OUT/'backtest-report.json').read_text());model=json.loads((OUT/'candidate-model.json').read_text());selection=json.loads((OUT/'selection.json').read_text())
assert report['decision']['release_passed'], 'Release gate failed; keep the existing runtime model'
assert model['parameters']==selection['chosen']
assert model['edges_hours']==[0,1,6,24,72,168,336,720]
model['backtest']={h:{l:{k:c['candidate'][k] for k in ['n','events','actual_rate','mean_predicted','brier','log_loss','auc','timing']} for l,c in cells.items()} for h,cells in report['comparison'].items()}
model['validation_summary']={'unique_test_contacts':report['unique_test_contacts'],'relative_log_loss_improvement':report['decision']['relative_log_loss_improvement'],'relative_brier_improvement':report['decision']['relative_brier_improvement'],'final_replay_weeks':report['final_replay_weeks'],'source_cutoff_pht':report['source_cutoff_pht'],'report_sha256':hashlib.sha256((OUT/'backtest-report.json').read_bytes()).hexdigest(),'prospective_test':False,'day30_timing_improvement_uncertain':True}
target=REPO/'src/lib/conversion-runtime/model-v2.json';target.write_text(json.dumps(model,separators=(',',':')),encoding='utf8')
shutil.copyfile(OUT/'Backtest Results.md',REPO/'docs/forecast-v2-backtest.md');shutil.copyfile(OUT/'backtest-report.json',REPO/'docs/forecast-v2-backtest.json')
subprocess.run([sys.executable,str(Path(__file__).with_name('analyze_stage_replay.py'))],check=True)
print(json.dumps({'packaged':True,'version':model['version'],'model_bytes':target.stat().st_size,'customer_records_embedded':0,'release_gates':report['decision']['gates']}))
