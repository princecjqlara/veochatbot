# Ad visibility and source evidence

The report has two separate data sets: first-inquiry cohorts and the ad catalog.
Actual ads appear first by default, with recorded creative titles, real Page-post
thumbnails, video previews and links to the original post. Catalog ads remain
visible when a date range contains zero verified-source inquiries. Unknown-source
groups remain visible and can be filtered separately.

Catalog visibility does not reconstruct missing lead attribution. Inquiries and
qualification counts continue to use original first-inquiry cohorts. Referral
contacts count distinct Page contacts with actual referral events in the selected
dates, including returning contacts; they are not silently added to new leads.
Referral event counts are not billable Facebook clicks or impressions.

The existing Page tokens have Page permissions but no ad-account read permission.
Page-owned posts can still supply genuine previews. Metadata resolution first
tries an available Facebook user token, then reads the verified owned Page post.
It preserves existing media and titles if a later lookup fails. No customer origin
or bot permission changes during metadata refresh.

Connect Facebook ad details requests the read-only `ads_read` scope. The connection
endpoint verifies granted permission before listing accessible ad accounts. Import
Facebook ads reads batches of 100 and exposes cursor continuation. The UI pauses
after 30 batches and retains its cursor for the next click; it does not label a
partial import complete. Account names, status and metadata come from Meta.

Imported ads map to Pages only through authoritative creative Page IDs, such as
`object_story_spec.page_id` or the prefix of an effective object-story ID. Conflicts,
unproven Page associations and Pages outside membership are skipped. Names, budgets
and inquiry dates never substitute for an ad-source identifier. All import and
refresh mutations enforce authentication, Page membership and same-origin requests.
No Facebook campaign, creative, budget or customer message is changed.

Apply `202610280002_ad_inventory_visibility.sql` after earlier migrations.
`node scripts/release-ad-visibility.mjs` rehearses six invariants and rolls back all
fixtures; `--apply` commits the additive schema. The shared Page subscription helper
already retains `messaging_referrals` even when older callers pass only three fields.
The five-Page subscription repair restores that field if external configuration
has removed it, without changing Page routing or bot enablement.

Read-only diagnostics: `node scripts/audit-ad-visibility.mjs` checks actual catalog
coverage, Page-token permission scopes and metadata access. No token is printed.
The source-health receipt labels its subscription status with the last saved check
time; its stage-event count uses the database's original tracking activation.

Apply `202610280003_preserve_same_message_ad_origin.sql` as well. The earlier
cache writer compared timestamp strings when refining a first inquiry. Messenger
history has second precision while webhook times carry milliseconds, so it could
clear a valid ad link for the identical first message. The corrected writer uses
provider message identity, retains the same-message origin, clears a genuinely
earlier different-message origin, and ignores stale concurrent refreshes. Coarse
same-second ordering alone does not override a known first-message event.

The repair restores an origin only when a complete history confirms the exact
first message ID and a unique actual ad-referral event carries that same ID.
Different earlier messages and conflicting ad evidence are not guessed. Original
webhook times remain in the referral evidence. `release-ad-origin-identity.mjs`
rehearses regression invariants with rolled-back fixtures; `--apply` commits the
function and evidence-based repair. `verify-ad-origin-histories.mjs` rechecks all
currently linked five-Page contacts through the normal complete-history reader.
