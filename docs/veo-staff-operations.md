# Staff operations, salary, Page budgets and Jaucian

This release keeps the original launch cutoff and CJ Lara's existing Owner identity. It adds audited staff departure, client takeover, project deadlines, per-employee daily salary, branch/Page rankings, actual-salary calendar reporting and shared Page budget planning.

## Access and employment

Owner can remove lower roles, Team Leaders can remove managers/members in their branch, and managers can remove their members. Removal deactivates sign-in, clears the password credential and Page grants, blocks pending photo handoffs, and releases unfinished clients to workers assigned to those Pages. Financial records, prior salaries and the hierarchy remain available to authorized supervisors. A departed supervisor does not silently deactivate their active descendants.

A selling member or manager can claim a released client. The transaction locks the claim, transfers only unfinished, never-fully-paid orders with an attribution audit, and assigns remaining project work to the claimant. Completed financial orders keep their original seller and commission. Overdue work follows the current project assignee. Clients without an order can be added to My Clients and released/claimed through the same roster.

## Verified money and delivery

Both order-based payment entry and the lead-stage confirmation option write the same immutable verified payment ledger. The optional Converted checkbox is an explicit human confirmation performed atomically with a verified payment. Merely creating an order, changing a lead stage, entering an amount or uploading an image cannot establish payment. A receipt requires Converted status, an order, full verified settlement, current attribution/Page access and explicit team/human Telegram mappings. Those requirements are checked again immediately before forwarding.

Project work is due 24 hours after its first qualified verified payment. A worker can attest that the project is finished, with a reason, while the client's balance remains unpaid. That stops staff-overdue classification while retaining the outstanding balance. Supervisors can reopen work with an audit record. Financial Closed/Done milestones and project delivery remain distinct.

Daily salary uses the worker's frozen personal target: both Closed and Done must reach the target for 40%; otherwise 35%. The rate applies to that day's full verified completion values. Today is provisional until Philippine midnight; refunds and corrections retain adjustments. Page salary allocation uses largest remainders so Page shares sum exactly to the whole worker/day/currency commission, including rounding. Former staff retain historical reporting.

## Calendar, ranking and Page planning

Members and managers cannot open calendar, ad-performance or Page budget reports; both server middleware and the new APIs enforce this. Team Leaders see their authorized branch and Pages, and CJ sees all VEO teams. Supervisors can filter performance, clients, financial milestones and salary by employee, Page and Philippine dates, and inspect outstanding balances and longest-overdue work. Rankings support deal results, overdue work and on-time completion, overall within the authorized branch and per Page.

The compact calendar shows verified completion-day values, actual employee commission and recorded ad spend. Cash receipts are displayed separately. Missing spend stays unavailable, and incomplete spend keeps net values provisional. The previous modeled 40% salary allowance is not used for this calendar.

Individual capacity retains the best three positive eligible Done Deal days in the previous 14 completed Philippine dates, averaged, multiplied by 80% and rounded down; fewer than three days gives target 1. Individual targets freeze for the day. Team quotas sum participating workers' targets, while full capacity includes the roster. Page allocations conserve each worker's target across their permitted Pages, using editable weights and largest remainders; assigning multiple Pages never multiplies capacity. Revoking a preferred Page falls back to valid remaining allocations.

The Page planner ports `veo ad budget/budget-model.js` with its aggressive/conservative growth rules. It uses authoritative attendance and allocated quota instead of caller-provided headcounts/maximums. The capacity reserve is applied once because worker capacity is already buffered. Spend cannot exceed allocated quota times entered CPA. Shared sales quotas remain identical in VEO, Jaucian and the budget planner; expected ad acquisitions are shown separately and can be lower. Plans recalculate after roster/attendance/assignment changes. This release does not change budgets in Meta.

## Existing Jaucian bot

The existing bot, approved VEO groups, identity directory and durable delivery outbox are reused. Owner explicitly maps each application team to an approved group and each person to a numeric Telegram identity. Current human membership is verified before saving. Team Leaders can also be mapped to a primary group in their branch. Usernames collected at sign-in are self-reported metadata and do not grant or bind permissions.

Regular scheduled reports run at 08:00, 16:00 and 00:10 Philippine time; the midnight report closes the previous financial day. They include Closed/Done counts and quotas, current waiting clients, work deadlines, employee client lists, assigned Pages and tomorrow's participation. Salary and ad-budget amounts remain in the authenticated app. Reports use immutable multipart manifests and independent acknowledgments, and current team/Page permissions are rechecked before each part. Unknown acknowledgments are held rather than blindly resent. Old daily ledger-report jobs are retired to avoid a fourth report. No historical slots are backfilled before activation.

After 16:00 the normal scheduler creates at most one non-anonymous tomorrow-availability poll per mapped group. Existing Jaucian votes are imported only for tomorrow, after launch, by matching the verified numeric identity and group. Vote withdrawal restores unknown; update-ID fencing prevents a delayed webhook from overwriting a newer vote. A later manual workspace declaration wins over an older Telegram vote. Reported Page access is shown to supervisors for review and does not automatically grant app access.

Membership is polled in bounded batches using the current team mapping. Only a confirmed human `left`/`kicked` response, after proven membership in that same group, triggers automatic removal. Remapping someone to a group they have never joined cannot fire them. Lookup outages stay unknown, retain access and expose retry health. The Owner is excluded. Unmapped people are never guessed or removed.

Cross-service access is through authenticated tenant-bound APIs; database administrator credentials are not shared. Telegram receipts never create another sale. Photos remain private temporary objects, deleted after acknowledged delivery or seven-day expiry. Cleanup also clears only processed raw webhook payloads older than seven days, retaining event keys/metadata for deduplication. Financial history, archives and contact records are not deleted. Telegram/planning outages do not stop new-event collection.

## Rollout and verification

Apply migrations 020–025 before deploying the compatible APIs and scheduler. Run the VEO tests and production build, Jaucian's required `py validate_project.py`, migration preflight, the production workspace/integration/operations probes, and scheduler recovery verification. Use only normal scheduled runs for actual Telegram delivery. `scripts/verify-veo-operations.mjs` checks role/Page boundaries, actual salary calendar, conserved Page/team targets, reciprocal workforce/report access and retained data without creating employees, sales or messages. It requires the production integration secret as well as the maintained database credentials; keep pulled environment files inside ignored `.vercel/` storage.

The November 6 release validation passed all 1,503 VEO tests in 187 files, including 23 executable database workflow tests, and the production build. Jaucian passed all 1,311 required validation tests. Migration preflight and application preserved 41 identities, 52 Page grants, 658 retained payments and the original launch cutoff. No browser was connected for interactive visual QA; rendered component tests and production authenticated API probes provide the recorded UI/workflow coverage.

Migration 025 additionally checks that a Team Leader's saved primary Telegram group still belongs to a current team in that leader's branch. Late observations from a former group cannot remove the leader after a team remap. The server directory withholds obsolete groups until a new current membership is verified. Targeted database and directory regression tests cover the remap, normal confirmed-departure removal and continued access for active descendants.
