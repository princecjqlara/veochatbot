# Approved receipt photo cleanup

Receipt evidence consists of stage, payment and order photos. The old workspace
cleanup removed the submission's payment photo after Telegram delivery, but
left stage and order photos until their seven-day expiry. It also depended on
the larger workspace worker reaching its cleanup phase. This could retain
unnecessary files; current quota usage still requires a live measurement.

The workspace worker now removes all three private evidence photos immediately
after it records confirmed Telegram delivery. A separate, authenticated
`/api/cron/receipt-photos` job runs every minute. It finds remaining photos by
their own undeleted metadata, including older bundles whose submission/payment
photo was already cleaned. It also runs the existing delivered/expired-file
cleanup. The independent job continues during a temporary background pause;
the explicit full database recovery gate still takes precedence.

Approval queues Telegram delivery. Queued, pending, failed or unacknowledged
deliveries retain their evidence for retry through the existing expiry policy.
Deleting before the bot has fetched its three photos would break forwarding.
Once sent, Telegram retains its copy; this cleanup removes the application's
temporary storage files. It does not withdraw Telegram messages or delete
receipt details, review decisions, orders, payments, salaries or audit history.

The delivered sweep uses a bounded inner-join metadata query for at most ninety
photos. It verifies approval, matching submission identity and a recorded
delivery timestamp before removal. Files are removed through the Storage API,
then their application metadata is checkpointed. A failed deletion or failed
checkpoint remains retryable. The next scheduled sweep can recover an
interrupted run without replaying a sale or Telegram send.

Deployment runs the receipt cleanup regressions, the complete receipt/accounting
SQL regression suite and source type checking before the production build. A
failure prevents the new deployment from replacing the live application.

Supabase file Storage and PostgreSQL database/disk usage are separate metrics.
Removing photo files addresses retained file storage, not every database,
compute, egress or Vercel usage limit. Deletion does not reverse bandwidth
already used, and the billing-period storage average may take time to decrease.

References: [Storage deletion](https://supabase.com/docs/guides/storage/management/delete-objects),
[Storage usage](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size),
[Egress usage](https://supabase.com/docs/guides/platform/manage-your-usage/egress).
