# Telegram relinking and salary date ranges

In **My profile → Telegram account connection**, a linked user can choose
**Relink Telegram account**. Using the intended Telegram account, send `/link`
to Jaucian and paste its private ten-minute code into VEO. The current link stays
active until verification succeeds. Canceling or a failed check keeps it intact.
The Telegram groups screen also links to this profile control; its existing
supervisor group, topic and Page-routing tools remain available.

The server checks current human membership in an approved group, the active VEO
account and tenant, and the identity the user originally selected to replace.
The database consumes the code and switches the identity atomically. Another
user's Telegram identity cannot be claimed. Expired, used, cross-tenant and
stale-link requests fail without replacing the current mapping. Normal initial
linking cannot replace a different identity.

When the numeric identity changes, current membership proofs and Page grants
created solely by Telegram automation are invalidated. Manual Page assignments,
VEO roles, clients, sales, attendance history and salary records remain attached
to the same VEO account. Ready becomes Busy until the user confirms readiness
again. The scheduled membership check rebuilds eligible group access for the new
identity. A same-identity reverification retains its other memberships and grants.
The audit records before/after numeric identities without storing the private code.

**Salary** is available to Head, Team Leaders, Managers and Members. Head sees
permitted staff across teams; Team Leaders see their branch; Managers see their
own commission and permitted staff; Members remain restricted to themselves.
Choose **From (PHT)** and **To (PHT)**, including both dates, plus an optional
Page and employee. Today, Last 7 days, This month and Recent history shortcuts
are available. Reports cover up to 93 days from workspace launch through today.

The selected-period statement shows calculated commission totals by currency
and an employee breakdown above the existing daily ledger. Currency amounts
are accumulated as integer minor units without combining currencies or
recalculating qualification rates. Today's commission is labelled provisional;
the statement does not imply a payout. Existing daily details, employee
profiles, receipts and client tools remain available. Changing dates clears
the previous statement while loading; late requests cannot replace a newer range.

Migration `202611100002_veo_telegram_relink.sql` replaces the pairing-code issuer
to allow fresh proof from an already linked Telegram identity and adds one
service-only relink function. Applying it does not relink any production user.
Run `scripts/release-telegram-relink.mjs --preflight` before `--apply`; the script
applies only this migration, validates privacy and retained record counts, and
excludes unrelated local receipt-policy drafts. Existing Jaucian `/link` support
is reused; no bot code, webhook, scheduler or Telegram destination is changed.

Verification includes PostgreSQL tests for identity replacement, stale/foreign
proof, existing-account protection, retained manual access/history and service
permissions; component/API tests for link/relink/cancel/retry and salary ranges
across all roles; and the full regression suite and production build. Live
verification uses authenticated read-only checks. The user must complete their
own Telegram code exchange; no real user identity is relinked for a test.

The release passes **2,109 tests in 279 files**, including **52 focused checks**,
and the production build with lint/type checks. The production migration
rollback preflight preserves all retained inventory and launch cutoffs and
confirms that pairing codes and relinking remain private. No browser is
connected, so component tests and authenticated HTTP reads provide the UI
checks available in this environment.
