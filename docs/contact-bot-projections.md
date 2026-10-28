# Contact bot permissions and conversion projections

Contacts and the Ad Lead Quality contact drilldown show an individual bot-permission
switch, an effective eligibility reason, and a conversion forecast. Filters select
all contacts, permission ON, or permission OFF **before pagination and counting**.

OFF blocks AI replies and automatic conversational follow-ups, including delivery
checks after generation and before each bubble. It cancels pending bot-owned work
and advances the conversation epoch. ON permits future eligible replies; it sends
no message and does not replay cancelled jobs. Page-wide settings, trial limits,
human handoffs, opt-outs, closed stages and messaging windows still apply. The
switch never edits a lead's stage, collected answers, or Page-wide configuration.
Manual campaigns are separate user-directed actions. Existing permissions default
to ON to preserve behavior; rollout does not enable any previously stopped bot.

The server uses model `dd7f0ca783ad1651`, trained through October 24, 2026, on the
five audited Pages. It uses boosted survival rates with conversation activity,
quote replies, completed details, recency, Page, industry and inquiry timing.
Historical behavior receives a selected 90-day half-life. The prior model
`eddb1b3d6b59c75e` remains the explicit fallback for snapshots lacking these signals.
Facebook Page IDs select the trained Page rather than a mutable
display name. Other Pages show unavailable rather than an unvalidated transferred
probability. Independent Python and TypeScript implementations match on 210
synthetic upgraded cases and 48 prior-model cases. No customer records are embedded
in either model asset.

Projections are available from the first identifiable inquiry, including a single
question with no agreement, quote, selected duration, completed form or known
industry. Each contact shows Day-7, Day-14 and Day-30 payment probabilities. The
signal-stage replay disclosure compares historically similar early conversation
signals with later confirmed outcomes. Agreement itself was not independently
labeled; a quote or completed form does not prove acceptance or payment.

Projection policy `stage-validation-2026-10-29` keeps probabilities unchanged and
requires at least 30 later replay confirmations and 100 replay contacts within the
signal group before displaying an individual conditional date, in addition to
the existing training/support checks. A supported shorter horizon may be shown
when a Day-30 date is unavailable; its actual horizon is explicitly labeled.
The existing first-issue ledger remains immutable and stores the policy version
inside the prediction. See `early-contact-backtest.md` for the descriptive audit.

The target is first documentary payment/deposit confirmation, not private purchase
intent or bank settlement. Historical audited payment evidence is retained. New
live confirmation accepts explicit page payment acknowledgements; customer claims,
administrative paid tags and ambiguous bill credits are not automatically verified.
A CRM Converted label without payment evidence is shown separately.

Probabilities are conditional on remaining unconfirmed at the displayed source
cutoff, by 7, 14 and 30 days **from the original first inquiry**. Closing dates are
conditional on confirmation within Day 30. The upgraded replay has 5,519 unique
test contacts with at least one mature horizon. At 24 hours, mean timing errors
are 1.26 days for Day 7 (72 later payers), 2.36 days for Day 14 (80), and 5.41 days
for Day 30 (40). The Day-30 improvement is uncertain: the paired 95% day-bootstrap
error-difference interval is -1.31 to +0.48 days. Dates remain rough, not promises.
The earlier 6.48-day figure describes the prior model on a different supported
sample; it must not be compared directly with the new 5.41-day result. A closed
30-day window is not a never-buying prediction.

Remaining days and a conditional range are shown from the source check. Range
corrections were fitted on earlier development cohorts; measured replay coverage
is disclosed rather than promised. Individual dates require at least 100 mature
group records, five later confirmations and 30 replay confirmations at that
checkpoint/horizon. Sparse cases retain a probability but withhold a personal date.
Day 7/14 conditional day estimates appear in details when supported.

See [the complete backtest](forecast-v2-backtest.md) and its machine-readable
calibration, Page comparisons and uncertainty in `forecast-v2-backtest.json`.
Equal horizon/checkpoint log loss improved 5.8%, and Brier error improved 4.1%.
These are error reductions, not a percent-correct claim. Development used July
and August; locked weekly replay starts September 15, after development outcomes
mature. Each replay model trains strictly before its incoming week. Some September
history was previously reviewed, so this is historical replay, not a new prospective
trial. Recent immature outcomes are excluded from each horizon's scores.

Probability calibration still needs care: at the 24-hour checkpoint, the new
30-day mean probability was 2.34% versus 1.70% observed. The contact details
disclose this comparison for their checkpoint. Improved ranking and prediction
error do not make the individual percentages exact or demonstrate guaranteed
profitability. Future prospective results must mature before recalibration.

Refreshes page through the actual Messenger conversation. A remaining cursor,
read failure, repeated cursor or safety limit never becomes a silently truncated
complete source. Only messages created before the source cutoff enter evidence;
features freeze at the validated 0/1/6/24/72/168/336-hour checkpoints. Later industry
or form disclosure cannot influence an earlier checkpoint. Private message text is
processed in memory; persisted snapshots contain model features and evidence IDs.
Stale sources are explicitly labelled. Visible refreshes are bounded to two at once.

Canonical first-inquiry evidence can refine legacy cohort dates without editing
contact intake timing or inventing source ads. Earlier actual inquiries clear an
incorrect later origin. A later concurrent refresh cannot replace newer evidence.
New live predictions append a versioned hourly issue record; later outcomes do not
overwrite an earlier issue. Future forecast evaluation still requires verified
later outcomes and mature horizons. Retraining is separate from refreshing a score.

The tables have RLS and no anonymous/authenticated direct access. API handlers
verify Page membership; mutations require same-origin requests. The SQL switch
checks the acting member again. Release verification uses rolled-back fixtures;
no actual customer is switched or messaged merely to test the release.
