# Assigned Page sync and suspension checks

Members, Managers, Team Leaders and Owner can sync their currently assigned Pages
from Collection health. The Contacts page uses the same workspace endpoint.
Facebook reads use the saved server-side Page token from the Owner connection;
staff do not connect personal Facebook accounts or receive the token.

The API checks current sign-in, workspace launch, Page access and storage health
before reading Facebook. It reads at most 50 contact identities per batch, shares
the existing Page lease with automatic sync, and retains the cursor on failure.
The database checks the acting staff account again before saving, including
suspension, active status, tenant and Page access. It keeps existing names and
stages, fills missing names, and does not import historical messages or create
historical activity, sales or background source jobs. Disabled historical import
endpoints remain disabled.

Migration `202611190001` changes the existing identity insert's authorization;
deploying the application alone does not install it. Both entry functions remain
service-only. Browser-supplied actor IDs and Facebook tokens are ignored.

Suspension denies sign-in, existing signed-session access, manual sync, receipt
submissions and staff actions. Shared workspace routes return a structured 403
for suspended users. Managers and Team Leaders manage only members in their
permitted branch; supervisors are exempt. Timed suspensions expire automatically
and both timed and indefinite suspensions can be lifted early. The saved warning
policy controls automatic suspension. This release does not enable policies or
suspend anyone. Earned salary, financial records and Page grants are retained.

Regression coverage includes the sync route, Contacts sync client, workspace
screen, sign-in/session checks, discipline controls and the full SQL integration
suite. Production verification uses assigned-Page Facebook reads plus rolled-back
suspension probes. No test suspension or financial transaction is committed.
