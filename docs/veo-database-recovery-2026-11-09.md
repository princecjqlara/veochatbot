# Database recovery and bounded hierarchy traversal

The source SQL used recursive `UNION ALL` hierarchy walks without detecting
cycles. A cyclic or corrupted staff graph could keep permission and reporting
queries running indefinitely. This is a confirmed code risk; a production cycle
has not been verified while PostgreSQL refuses connections.

`202611090001_veo_hierarchy_recursion_guards.sql` makes the branch, ancestor-grant
and page-permission walks stop on repeated identities or at 64 levels. Invalid
graphs fail closed. Departed staff remain historical hierarchy nodes, and normal
Page-grant inheritance stays unchanged. The migration does not rewrite accounts
or financial records.

Set the production environment variable `VEO_DATABASE_RECOVERY_MODE=true` and
redeploy to stop application database reads and scheduled workers during
recovery. Provider/CSRF/sign-out endpoints remain available. In workspace mode,
Facebook webhook ingestion still saves events to the durable inbox; processing
waits until recovery ends. Telegram callbacks return retryable failures.

After the database accepts connections, run:

```powershell
node --env-file=.env.local scripts/repair-veo-hierarchy.mjs --inspect
node --env-file=.env.local scripts/repair-veo-hierarchy.mjs --apply
```

The repair validates the configured project and all four existing function
bodies before applying only this migration in a bounded transaction. An
unexpected production definition stops the repair for review. Existing
operator-set function limits are retained. The ordinary full migration runner
must not be used to install unrelated pending changes during this incident.

Verify simple reads and owner/staff scope before setting recovery mode to false
and redeploying. Check queue health after workers resume. If the database remains
unhealthy with application work quiesced, collect PostgreSQL startup/resource
logs through project-management access before attributing the crash to a
particular query.
