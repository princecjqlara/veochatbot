# Ad Lead Quality

`/dashboard/ad-quality` updates every 15 seconds while visible and on window focus.
It supports all accessible Pages or one Page, Today, last 7/30 Philippine calendar
days including today, all time, and inclusive custom calendar-date endpoints.
Future periods are never presented as completed observations.

The date filter selects the **original first-inquiry cohort**. Every row shows the
contact's current recorded pipeline stage, including later decisions. It does not
select contacts merely because they were disqualified or converted on that date.
NQ/all = current Not Qualified contacts / all inquiry contacts in the selected
cohort. Pending, opted out, qualified, orders, and CRM converted remain separate.
A CRM converted label is not independently verified payment.

Only a signed incoming message or customer button inquiry with a source ad referral
can verify original acquisition. Thread-open events are retained as touches but
are not inquiries. Later clicks never overwrite first-inquiry attribution. An
out-of-order earlier inquiry clears attribution belonging to a later message;
conflicting evidence on the first message is quarantined as Unknown. Postback
identifiers are stable synthetic event identifiers, labelled `postback:...`, not
Messenger message IDs. Exact Meta timestamps and evidence keys remain available.

Old contacts without retained source ad evidence are Unknown. Missing evidence is
not organic. Audited historical first-inquiry timestamps may be imported from the
existing verified dataset without changing contact tags, message history, or
inventing ad assignments. Remaining old CRM first-interaction dates are explicitly
counted as legacy, since a referral or historical sync can differ from a first
customer inquiry. Contacts without any inquiry timestamp are counted as excluded
coverage rather than silently assigned a date.

The source catalog initially uses Meta-provided ad context, when supplied. Ad ID
links open Ads Manager. Optional `ads_read` reauthorization and bounded metadata
lookups retrieve ad/campaign/ad-set/creative names using authorized account access.
An ad/creative ID does not establish the exact served dynamic asset combination.
Ad-source capture and counts do not depend on an ad-name lookup succeeding.

Database objects are additive, have RLS enabled and no client-role access. Only
server-side service-role functions query them, after authenticated Page membership
checks. SQL aggregation avoids the default 1,000-row client read limit. The contacts
drilldown is separately authorized and paginated. Qualification transitions are
audited by a database trigger, covering manual, Messenger and chatbot changes.
Missing assessment is not used as a negative training outcome.

Release phases:

1. Run unit/type/build checks and `scripts/release-ad-lead-quality.mjs --preflight`.
   The SQL verification uses a transaction and rolls back every fixture.
2. Apply the additive migration with `--apply-schema`.
3. Optionally `--seed-audited` from the verified local historical source.
4. Deploy the application and preserve the existing production alias.
5. Add `messaging_referrals` to the relevant app and Page subscriptions, preserving
   every existing field and callback. Partner-routed Pages keep their existing app.
6. Verify report authorization, aggregate/drilldown reconciliation and actual
   receipt of a future Meta referral. A zero-ad empty state is not proof that
   Meta has delivered a genuine live ad-click event.

No ads are paused, edited, or budgeted by this feature; it is evidence and reporting.
