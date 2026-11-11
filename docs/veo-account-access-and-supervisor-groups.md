# Account access and supervisor Telegram groups

The November 11 audit found six active retained staff identities with sign-in
disabled and no saved email/password. Their old login details were also absent
from the verified setup backup. Roles, hierarchy and multiple Page grants remain
present. Emails must be supplied by the Owner; recovery does not invent addresses
or reactivate departed accounts.

The release leaves every current email and password hash unchanged. An Owner
can enter the same existing email and password privately in Accounts for a
restored identity; no replacement password is generated. Both verified user
archives predate these six identities, and a read of the original project
returned HTTP 503, so the missing old credentials cannot currently be copied.

Accounts now has an Owner-only sign-in status panel for every account, including
configured accounts that may need a reset. It distinguishes missing email,
missing password, disabled sign-in, cooldown and departed staff. Saving complete
sign-in preserves identity, role and Page grants and clears the email's login
cooldown. Password-only changes on incomplete accounts roll back with guidance
to complete setup. Password status is computed inside private database functions;
no hash is returned to the status panel.

The saved roster was imported after the earlier direct-team backfill, leaving
two Team Leaders without their direct-member teams. The migration adds only
missing active Team Leader/Manager teams and preserves existing teams. Login
recovery also ensures a supervisor's missing team exists. Creating a direct
team does not add workers or duplicate the child managers' capacity or salary.
Team Leaders can create members directly under themselves, with no Manager
account, and use their direct-member team for Telegram groups and multiple Pages.
Accounts also lets the Owner or a Team Leader move an existing member to a
permitted Team Leader/Manager within their branch. The same user ID, email,
password, Page assignments and financial records remain. The new supervisor
must already have every assigned Page, and stale edits are rejected. Earlier
orders keep their recorded teams; Telegram membership is checked against the
new reporting line on the ordinary scheduled sync.

Telegram setup already stores multiple groups per supervisor and multiple Page
routes. The new assignment summary lists every supervisor's granted Pages and
managed groups and provides **Add another group**. Adding a group preserves the
others. Each team/Page has one delivery destination, and moving it requires an
explicit option. Human membership, approved groups, branch permissions and
supervisor Page grants continue to apply.

Validation covers the actual migrated PostgreSQL schema, preserved identities,
grants and nonzero capacity, cooldown cleanup, departed/cross-branch denial,
Owner-only status, multiple groups for both supervisor roles, multiple Page
routes, explicit moves, and the existing membership UI.
