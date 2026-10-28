# Reproduce the October 28 forecast revision

The private input is `data/conversion-forecast-prototype/features.jsonl` in the
workspace, with its existing metadata and audited payment evidence. Do not commit
customer records. Install `requirements.txt` in an isolated Python environment.
The original `conversion-forecast-prototype/model.py` supplies the unchanged
baseline and metric definitions. `PROTOCOL.md` defines development, replay and
release gates. A failed candidate must not be packaged.

Run, sequentially from this directory:

```powershell
python train_v2.py --stage develop
python train_v2.py --stage calibrate
python train_v2.py --stage test
python analyze_replay.py
python train_v2.py --stage final
python package_model.py
python make_reference.py
python -m unittest discover -p 'test_*.py'
```

The stages write `outputs/conversion-forecast-v2` in the workspace. Keep the
locked selection unchanged after replay. Packaging refuses a failed release gate.
Production is a static JavaScript tree evaluator; Python and scikit-learn are
offline training dependencies only. Tree inputs use float32, matching the library.

For a landmark feature vector x and future interval j, the fitted rate is
`lambda_j(x) = 1.25 * exp(base + sum(tree_j(x)))`. The multiplier was selected on
earlier out-of-period development predictions. The same tree ensemble receives
the interval as an input. Person-period training uses observed exposure e,
target `event/e`, and weight `e * 2^(-record_age_days/90)`, so censored leads
contribute only their observed time. This is a Poisson survival likelihood.

Given no confirmation at source age a, the remaining probability by h hours from
first inquiry is `1 - exp(-sum(lambda_j * overlap([a,h], interval_j)))`.
The conditional median solves `1-exp(-integrated_hazard(a,t)) = 0.5 * P`.
The 10th/90th percentiles solve the same equation with 0.1/0.9 and receive a
nonnegative interval margin estimated from earlier development residuals.
All days are elapsed days; displayed calendar dates use Asia/Manila.

Do not use later messages, eventual industry, payment information or future
qualification decisions in the earlier feature vector. Refreshing conversation
evidence is separate from retraining. The forward issue ledger preserves each
version's first forecast per contact/hour; never rewrite it after a later outcome.

`analyze_stage_replay.py` describes the locked replay using each contact's frozen
conversation signals. Packaging runs it without refitting parameters. Its output
supports probabilities before an agreement and discloses accuracy for early
inquiries separately. An agreement was not independently labeled: never equate
these signal groups with verified agreed / not agreed. Individual dates require
the existing 30-replay-confirmation minimum within the signal group, plus training
support. Model-version mismatches withhold stage-specific dates. Probability
formulas are unchanged. The policy version is recorded in every forecast response.

`node upgrade-snapshots.mjs` rehearses the audited feature-cache upgrade inside a
rolled-back transaction. `--apply` commits it. It changes only the exact older
audited cache snapshot, never newer live sources, contact permissions or stages.
Run it only after the model passes the release gates. It sends no messages.

Apply `202610280001_fast_ad_contact_drilldown.sql` after the earlier migrations.
It filters/counts narrow cohort rows before fetching details, avoiding a full
contact self-join. `node release-ad-list-performance.mjs` rehearses it inside a
rolled-back transaction and checks identical records and ON/OFF counts; `--apply`
commits the function change. It changes no customer records or model parameters.
