# Hourly Meta Ads fetch

Use the existing cron-job.org job for Meta Ads. Vercel hosts the endpoint but does not schedule Meta Ads fetching.

Set the existing job to:

- URL: `https://veochatbot.vercel.app/api/cron/meta-ads-sync`
- Method: GET
- Schedule: every hour at minute 0, timezone Asia/Manila
- Request header: `Authorization: Bearer <production CRON_SECRET>`
- Save responses: disabled
- Enabled: yes

The existing authorization and encrypted Meta Ads credential are required. Without them, the endpoint returns an explicit waiting-for-connection result. Interrupted imports resume when the scheduler next invokes it. The manual fetch action remains available in Budget.

To inspect and update an existing matching job without creating another one, load `CRONJOB_API_KEY` and the production `CRON_SECRET` through the environment, then run:

```powershell
node --env-file=.env.local scripts/configure-meta-ads-cron.mjs --inspect
node --env-file=.env.local scripts/configure-meta-ads-cron.mjs --apply
node --env-file=.env.local scripts/configure-meta-ads-cron.mjs --verify
```

If more than one matching job exists, use `META_ADS_CRON_JOB_ID` to select the intended job. The helper refuses to create jobs, modify another endpoint, or run deliveries manually. Its private backup and safe verification receipt are saved under the ignored `.vercel/meta-ads-cron-job-org` directory. Do not commit or share API keys or the scheduler secret.
