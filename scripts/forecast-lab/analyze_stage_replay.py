"""Describe the locked replay by signals available then; never refit on it.

These are behavior groups, not independently verified agreement labels.
Only aggregate metrics are packaged in the application; no customer IDs/text.
"""
import collections
import hashlib
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'conversion-forecast-prototype'))
import model as legacy

OUT = ROOT / 'outputs/conversion-forecast-v2'
REPO = ROOT / 'tokko-chatbot'
EARLY = {'initial_inquiry', 'active_conversation', 'returned_later'}
LABELS = {
    'inquiry_or_conversation': 'Inquiry / conversation signals',
    'quote_or_details': 'Quote response / package details',
}


def signal_group(snapshot):
    if snapshot['b'] in EARLY and not snapshot.get('form') and not snapshot.get('duration'):
        return 'inquiry_or_conversation'
    return 'quote_or_details'


def frozen_snapshot(record, row):
    assert record['first'] == row['first']
    assert record['page'] == row['page']
    assert record['observed'] >= record['first'] + row['horizon'] * legacy.HOUR
    event = record.get('event')
    age = (event - record['first']) / legacy.HOUR if event is not None else float('inf')
    assert age > row['landmark'], 'Already confirmed at the forecast checkpoint'
    assert row['label'] == int(age <= row['horizon'])
    snapshots = [s for s in record['snapshots'] if s['h'] == row['landmark']]
    assert len(snapshots) == 1, 'Require the original exact checkpoint, never a later snapshot'
    snapshot = snapshots[0]
    evidence = snapshot.get('industry_evidence_ms')
    assert evidence is None or evidence <= record['first'] + row['landmark'] * legacy.HOUR
    return snapshot


def metrics(rows):
    result = legacy.metrics([(r['label'], r['probability']) for r in rows])
    paid = [r for r in rows if r['label']]
    mean = lambda values: statistics.mean(values) if values else None
    result['timing'] = {
        'n': len(paid),
        'mae_days': mean([abs(r['predicted_days'] - r['actual_days']) for r in paid]),
        'within_3_days': mean([abs(r['predicted_days'] - r['actual_days']) <= 3 for r in paid]),
        'central80_coverage': mean([r['q'][0] <= r['actual_days'] <= r['q'][4] for r in paid]),
    }
    return {k: result[k] for k in ['n', 'events', 'actual_rate', 'mean_predicted', 'auc', 'brier', 'log_loss', 'timing']}


def main():
    replay = json.loads((OUT / 'replay.json').read_text())
    assert replay['selection_sha256'] == hashlib.sha256((OUT / 'selection.json').read_bytes()).hexdigest()
    rows = [json.loads(line) for line in (OUT / 'replay-rows.jsonl').read_text().splitlines()]
    rows = [r for r in rows if r['model'] == 'candidate']
    wanted = {r['id'] for r in rows}
    records = {}
    with (ROOT / 'data/conversion-forecast-prototype/features.jsonl').open(encoding='utf8') as source:
        for line in source:
            record = json.loads(line)
            if record['id'] in wanted:
                assert record['id'] not in records
                records[record['id']] = record
    assert wanted == records.keys()
    grouped = collections.defaultdict(list)
    by_behavior = collections.defaultdict(list)
    for row in rows:
        snapshot = frozen_snapshot(records[row['id']], row)
        grouped[(str(row['horizon']), str(row['landmark']), signal_group(snapshot))].append(row)
        by_behavior[(str(row['horizon']), str(row['landmark']), snapshot['b'])].append(row)
    def nested(groups):
        result = {}
        for (h, l, stage), values in sorted(groups.items()):
            result.setdefault(h, {}).setdefault(l, {})[stage] = metrics(values)
        return result
    runtime_model = json.loads((REPO / 'src/lib/conversion-runtime/model-v2.json').read_text())
    report = {
        'schema_version': 1,
        'model_version': runtime_model['version'],
        'projection_policy_version': 'stage-validation-2026-10-29',
        'source_cutoff_pht': '2026-10-24 18:05:59',
        'replay_sha256': hashlib.sha256((OUT / 'replay-rows.jsonl').read_bytes()).hexdigest(),
        'selection_sha256': replay['selection_sha256'],
        'unique_test_contacts': len(wanted),
        'stage_labels': LABELS,
        'groups': nested(grouped),
        'behaviors': nested(by_behavior),
        'notes': [
            'Post hoc descriptive breakdown of the existing locked chronological replay; no parameters were changed.',
            'Stage comes only from the original frozen checkpoint, never eventual messages, industry or outcome.',
            'Agreement was not independently labeled. Signal groups must not be described as verified agreed / not agreed.',
            'Every horizon has full follow-up. Each table cell counts contacts once; cells overlap across checkpoints/horizons.',
            'Dates are conditional on later payment/deposit confirmation within the horizon.',
            'Stage-specific dates require the existing minimum of 30 replay later confirmations, plus training support.',
            'Small or one-class groups cannot establish reliable individual probabilities. This is not a completed prospective test.',
        ],
    }
    packed = json.dumps(report, separators=(',', ':'))
    (OUT / 'stage-backtest.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    (REPO / 'src/lib/conversion-runtime/stage-backtest.json').write_text(packed, encoding='utf8')
    lines = ['# Projections before a commercial agreement', '',
             'A projection is available from the first identifiable inquiry, before selecting a package or completing business details. It forecasts first documentary payment/deposit confirmation within 7, 14 or 30 days from that inquiry.', '',
             'The following group had only inquiry / conversation signals at the frozen checkpoint: no completed business-details form, no selected duration, and no recorded reply after a quote. This is a behavioral proxy; explicit agreement was not independently labeled.', '',
             '| Checkpoint | Payment horizon | Contacts still unconfirmed | Later confirmations | Predicted average | Observed rate | AUC | Timing error, days |',
             '|---|---|---:|---:|---:|---:|---:|---:|']
    for l in ['0', '6', '24', '72']:
        for h in ['168', '336', '720']:
            cell = report['groups'].get(h, {}).get(l, {}).get('inquiry_or_conversation')
            if not cell:
                continue
            auc = 'N/A' if cell['auc'] is None else f"{cell['auc']:.3f}"
            error = 'N/A' if cell['timing']['mae_days'] is None else f"{cell['timing']['mae_days']:.2f}"
            lines.append(f"| {l} hours | {int(h)//24} days | {cell['n']:,} | {cell['events']} | {cell['mean_predicted']:.2%} | {cell['actual_rate']:.2%} | {auc} | {error} |")
    lines += ['', 'AUC measures ranking (0.5 is chance), not the percentage of correct buy/no-buy decisions. Timing error is measured only among later confirmations. Early probability is available even when an individual date is withheld for insufficient stage-specific evidence.', '',
              'The underlying model and probabilities are unchanged. This audit adds stage-specific accuracy disclosure and applies the existing minimum of 30 replay confirmations to dates in that stage. It does not establish that the forecast has become more accurate.', '',
              'Conversation snapshots use checkpoints at 0, 1, 6, 24, 72, 168 and 336 hours. Source refreshes check for documented payment and use the latest completed checkpoint; new messages between checkpoints are not claimed to be continuously scored.', '',
              'Refreshing source data does not retrain the model. The versioned forecast ledger supports a future prospective test once outcomes mature. Source observation ends October 24, 2026 at 18:05:59 PHT.']
    text = '\n'.join(lines) + '\n'
    (OUT / 'Early Contact Backtest.md').write_text(text, encoding='utf8')
    (REPO / 'docs/early-contact-backtest.md').write_text(text, encoding='utf8')
    print(json.dumps({'unique_test_contacts': len(wanted), 'stage_cells': len(grouped), 'at24_early': {h: report['groups'][h]['24'].get('inquiry_or_conversation') for h in ['168', '336', '720']}, 'runtime_bytes': len(packed)}))


if __name__ == '__main__':
    main()
