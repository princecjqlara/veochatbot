# Jaucian integration alignment, 2026-11-11

The production audit authenticated VEO → Jaucian and Jaucian → VEO. Both
directories, automatic setup, workforce observations and the authoritative
operations report returned HTTP 200. Anonymous callers were rejected with 401;
a signed-in non-Owner was rejected from the integration directory with 403.
The common commission rule remains 40% when both personal Closed and Done
targets are met, otherwise 35%; team totals cannot override a personal rate.

Jaucian's public health and database scheduler were healthy. Ordinary scheduled
runs had no overdue deliveries over five minutes, failed actions or stale claims.
Six approved VEO groups were returned, with existing topic configuration and
observed identities. The client assignment bridge advertises ready/busy, client
lists, offers, assignment acceptance and supervisor reassignment; the workspace
remains authoritative for permissions, assignments, payments and salary.

## Repairs

- The recovered launched tenant had no `veo_telegram_sync_state` row. The old
  migration populated that table only for tenants present at installation, so
  cron kept returning no work. Migration `202611110003` initializes missing
  launched tenants and makes the lease claim initialize future launches too.
  Existing cursors, leases and next-run times are preserved. Unlaunched tenants
  are excluded. The function remains private to the service role.
  The ordinary production cron completed its first successful automatic and
  workforce scan at 08:24 UTC, with no sync error or staff departure recorded.
- The Owner integration page now reports automatic-sync configuration, last
  success/errors, and retained accounts whose logins are disabled. A working
  API connection no longer conceals an unscheduled sync or excluded workforce.
- Jaucian receipt details now use the same Closed/Done topic or team override as
  the photo. Details also recheck the tenant, order, milestone, Closed Deal and
  destination against the authoritative submission before sending.
- Closed Deal captions and report reminders follow the current separate steps:
  create/link the Facebook order for Closed, then verify payment and mark paid
  for Done. Details show the actual linked order instead of `None`. Compatibility
  with retained older Closed Deal payloads remains; current VEO eligibility
  continues to enforce the order requirement before handoff.
- Jaucian setup counts include selling Team Leaders alongside Managers/Members.

## Setup still required

The database retains six staff accounts with disabled logins (two Team Leaders,
three Managers and one Member). Their account history was retained, but they are
excluded from the enabled bot directory. There were no verified numeric staff
mappings, group memberships, team/group links or Page routes. The audit did not
activate those logins or guess identities and group ownership.

An Owner must review the retained staff's access. Enabled staff can use the
existing Jaucian `/link` pairing and relinking flow. Supervisors then configure
the permitted team/group/Page routes in Telegram setup. A typed username or a
historical group message never proves identity. Membership is verified using
the existing bot, and failed reads remain unknown instead of removing access.

No real Closed/Done receipt was available for a production delivery check.
Mocked delivery tests cover routing, receipt context, retry acknowledgment,
uncertain-send suppression, temporary evidence and deletion. Production checks
read existing data and normal scheduler outcomes; no dispatcher was invoked and
no test Telegram message, sale, payment, receipt or staff activation was created.
The named migration release compares retained identities, login states, Page
grants, contacts, financial counts and launch cutoffs before commit.

Validation artifacts live in ignored `.vercel/jaucian-alignment-*` files in
both repositories. Run Jaucian's required `py validate_project.py` before its
deployment; its Vercel build gate runs that same complete suite. VEO validation
covers the migration's real SQL behavior, both HTTP directions, directory
permissions, new setup messages, full regression checks and production build.
