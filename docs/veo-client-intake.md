# Tokko client intake

New client assignment handles fresh inquiries before a sale. Choosing Ready does not assign a client automatically: a worker accepts an available inquiry, or the team leader offers it to a Ready worker who must accept. Assignment changes conversation responsibility only; it creates no order, Closed Deal, Done Deal, payment or commission.

For a handover, open **New Clients > My clients / Handovers** (or **Assigned clients / Handovers** for supervisors), select a Ready recipient, enter a handover reason and choose **Send handover offer**. The original worker stays assigned until the recipient accepts. In an approved linked Telegram group, `/handover` opens the same handover menu as `/reassign`; `/offers` shows incoming offers. Telegram and VEO share one current assignment. A team leader can arrange service handovers for clients with recorded sales; those sales keep their original seller and financial history.

Open **VEO workspace > New Clients**. Selling managers and members choose **Ready** before accepting a client; Ready lasts up to 30 minutes and stops at Philippine midnight. **Busy** cancels incoming offers. Acceptance automatically sets Busy and pauses the contact's chatbot using the existing bot-permission controls. A worker can choose Ready again when able to take another client.

The available queue includes contacts with activity since the workspace launch on currently permitted Pages, excluding existing sales, opted-out or unqualified contacts, accepted assignments, released clients and live reservations. Search by client name, ID, PSID or Page, and filter by Page. Existing client history remains accessible in contact profiles. Released clients retain their existing separate claim workflow.

Supervisors can offer clients or reassign conversation responsibility within their current branch and Page permissions. Recipients must be Ready; offers expire after 15 minutes or when Ready expires, whichever comes first. Members can offer their own clients without existing sales to Ready teammates or their selling manager on a shared Page. Reassignments require a reason. The current worker keeps responsibility until the recipient accepts. Recipients can decline; authorized supervisors and offer creators can cancel.

Acceptance checks the recipient, offer creator, branch, Page permissions, readiness, offer expiry and current assignment again under a transaction lock. Stale offers cannot transfer clients after access or ownership changes. Only one live pending offer can reserve a contact, and another branch cannot replace it. Stable request IDs allow retries without duplicate acceptance or offers. The legacy client-assignment action uses the same checks.

Conversation responsibility is separate from financial attribution. Existing orders, verified payments and Closed Deals retain their seller. An unfinished order's service assignee follows an accepted handover. The original seller can still complete an exact existing Closed Deal; unrelated new sales must use the current client owner. Supervisors retain the existing audited seller-correction workflow.

Ready/Busy operates in Tokko and does not require a Telegram mapping. It does not change attendance, quotas or Jaucian's active-for-tomorrow poll. Tomorrow attendance continues to come from verified Jaucian poll observations.

## Release and verification

Apply `202611080001_veo_client_intake.sql` through `scripts/release-veo-workspace.mjs --preflight` then `--apply` before deploying the app. Both commands preserve the launch cutoff and retained account, Page-grant and financial counts. Intake tables and RPCs are private to the service role; the authenticated API derives its actor from the session and checks the Origin on writes.

`202611080002_veo_client_intake_reads.sql` maintains a private, narrow queue projection from current contact changes, caches current branch/Page IDs within each request, fetches display names after pagination and uses an exact indexed lookup for client UUID searches. Contact edits update the projection in the same transaction; deleted contacts cascade out. Acceptance always rechecks the authoritative contact and assignment. New Clients loads its own authenticated scope without waiting for financial dashboard reports. RPC retries remain bounded and return a retry message if the database is busy.

Regression coverage lives in the intake section of `veo-receipts-sql.test.ts`, `VeoNewClients.test.ts`, `new-clients/route.test.ts` and the workspace navigation tests. Database cases cover readiness, retries, branch reservations, acceptance, expiry, reassignment reasons, revoked permissions, privacy, attendance preservation and financial handovers. Production verification must use read-only authenticated requests; do not accept live clients, change staff availability or create test sales during deployment checks.
