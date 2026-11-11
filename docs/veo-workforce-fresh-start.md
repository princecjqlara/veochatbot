# Workforce fresh start

The Owner explicitly requested deletion of all Team Leader, Manager and staff
accounts and their data after the earlier offboarding retained historical
identities. The November 11 reset targets only that workforce. It removes both
active and inactive non-Owner accounts, their user rows, teams, access grants,
Telegram memberships/routes, targets, quotas, attendance, salary snapshots,
capacity plans, intake dispatch records and staff-specific audit entries.

The Owner account/password, tenant launch date, Owner Page grants, connected
Pages/tokens, chatbot setup/knowledge, customer contacts, tags and unrelated
business records remain unchanged. Approved Telegram group catalog entries
remain available for new staff setup; old team assignments are removed.

The maintenance command is not an application endpoint or migration. Deploying
does not run it. Use it only for an explicitly authorized workforce deletion:

```powershell
node --env-file=.env.local scripts/reset-veo-workforce.mjs --plan
node --env-file=.env.local scripts/reset-veo-workforce.mjs --preflight
node --env-file=.env.local scripts/reset-veo-workforce.mjs --apply
```

The plan pins the current staff IDs, hierarchy and team IDs. A roster change
requires a new plan. Preflight executes the deletion and rolls it back. Apply
uses one transaction, checks the current Owner/project, holds workforce locks,
and stores the selected rows in ignored private backup storage. Credentials,
private backups and raw staff data must not be committed.

Dependencies outside the explicit workforce policy, including customer orders,
and unknown embedded staff references block the reset. The command compares
fingerprints of all protected public rows before and after deletion. It disables
only reviewed retention triggers during the transaction, restores their original
state, verifies no selected workforce rows remain, and keeps one minimal Owner
reset receipt without the removed staff identities.

Tests exercise full deletion against the real migrated PostgreSQL schema, Owner
and customer preservation, complete account/Telegram status after reset, restored
audit protections and refusal when business dependencies would be erased.

Use the separate `--legacy-authors` option with the same plan/preflight/apply
steps only when the Owner also requests removing unused imported author
identities. It selects disabled users with no email/password or workforce
account and accepts only knowledge-document and Drive-file author references
inside the Owner's Pages. It transfers those references to the Owner, preserving
all content and timestamps, then deletes the unused identity. Active standalone
accounts, foreign Page references and other dependencies block that operation.
