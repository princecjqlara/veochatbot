# Member warnings and suspensions

Open **Workspace → Warnings** as a Manager or Team Leader. Owners retain their
administrative access. The controls support issuing and removing warnings,
suspending a member for minutes/hours/days or until manual lifting, and lifting
either suspension type early. Every change requires a reason and stays in the
audit history. Supervisors can act only on active members in their branch;
Managers, Team Leaders and Owners are exempt from member warnings and suspension.

Each supervisor can save a warning limit from 1 to 100 and a default suspension
duration. Automatic suspension starts only when the supervisor enables it.
Saving an enabled rule applies it to current warnings. A member uses their
Manager's saved rule first, then their Team Leader's rule, then the Owner's
fallback rule. An explicit manual-only Manager rule takes precedence over an
automatic Team Leader rule. No rule is enabled by this release.

Only warnings count toward the limit. Salary holds, missing Telegram setup and
other attention notices do not count. Scheduled workspace processing records
new workflow warnings once per source and applies enabled rules. Removed
warnings remain excused when the source issue is checked again. Recorded strikes
remain until removed or included in a suspension. A suspension consumes its
current strikes, preventing immediate re-suspension when it expires or is lifted.
Prior strikes are available through the warning-history filter and audit record.

Suspension is separate from account deactivation and salary eligibility. It
blocks fresh sign-in, existing session authorization, staff API actions, receipt
uploads, resource access, exports, campaigns, Telegram client controls and new
client offers. Timed access restrictions expire on the next authorization check;
no scheduler run is required to restore access. Current offers are cancelled and
Ready status becomes Busy. Restored members must declare Ready again.

Migration `202611170004` adds private, RLS-protected policy, warning and suspension
tables and service-only functions. Old session cookies must pass a current
database check on each request. The suspension screen exposes only the member's
restriction and sign-out. A database outage does not bypass authorization.

Migration `202611170003` also commits valid member receipt evidence before
automatic approval calculations. The existing scheduled approval worker then
records approved deals and queues Telegram delivery. The inbox distinguishes
saved receipts awaiting automatic approval from independent supervisor review.
Connection timeouts are reported as unavailable saves rather than validation
failures, preserving the same request reference on retry.

Validation includes the full migration-chain SQL tests, old signed-cookie
revocation/restoration, branch and role denials, timed expiry and manual lifting,
warning removal, unchanged salary and Page grants, API validation and UI forms.
The hosted production build and source type check pass. A production rollback
probe verifies suspension authorization without leaving anyone suspended; the
release preserves existing account, receipt, order, payment and delivery counts.

Released November 17, 2026 after 172 focused automated checks, the source type
check and the hosted production build passed. Live Manager, Team Leader and
member warning reads returned HTTP 200. Forged member management permissions and
cross-branch suspension attempts returned HTTP 403; anonymous access returned
HTTP 401. A live member receipt upload returned HTTP 201 and its temporary
private test file was removed. No member was left suspended and no test payment
or Telegram message was created by verification. Visual browser QA was
unavailable because no browser session was connected.
