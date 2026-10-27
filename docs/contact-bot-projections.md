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

The server uses model `eddb1b3d6b59c75e`, trained through October 24, 2026, on the
five audited Pages. Facebook Page IDs select the trained Page rather than a mutable
display name. Other Pages show unavailable rather than an unvalidated transferred
probability. A 48-case synthetic reference test reproduces the Python probabilities
and conditional date quantiles. No customer records are embedded in the model asset.

The target is first documentary payment/deposit confirmation, not private purchase
intent or bank settlement. Historical audited payment evidence is retained. New
live confirmation accepts explicit page payment acknowledgements; customer claims,
administrative paid tags and ambiguous bill credits are not automatically verified.
A CRM Converted label without payment evidence is shown separately.

Probabilities are conditional on remaining unconfirmed at the displayed source
cutoff, by 7, 14 and 30 days **from the original first inquiry**. Closing dates are
conditional on confirmation within Day 30. The measured timing MAE was 6.48 days
for 52 supported later payers; dates remain rough, not promises. A closed 30-day
window is not a never-buying prediction.

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
