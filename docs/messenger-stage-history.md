# Messenger stages and smart history tags

Meta administrative notices update the current pipeline even when a person moves a lead backwards. Each notice is stored with its message ID, exact stage label and Meta timestamp. Duplicate and older notices are recorded without overwriting a newer Meta stage, a later dashboard decision, or an explicit intake reset. Customer-written text cannot set a lead stage.

Qualified, Not Qualified, Converted and Order Created map to the matching pipeline stages. Intake maps to New and Contacted to Engaged. Custom labels retain their exact Meta name, shown beside the pipeline bucket. Human stage decisions continue to stop bot delivery and queued follow-ups.

Smart tags such as **History: Qualified** and **History: Not Qualified** accumulate as stages are observed. Existing ordinary tags and their assignments are retained. These tags describe history; the pipeline shows the current stage. Stage changes no longer assign a Paid / Availed Service tag. A stage label is not payment verification.

The dedicated `/api/cron/messaging-auto-tag` schedule runs every minute, claiming up to six distinct Pages per invocation regardless of chatbot enablement. Webhook events provide the fast path; background scans reconcile missed events and rotate across connected Pages. Pagination also revisits the newest conversations so a backlog does not hide new edits. Meta permissions and API availability affect latency. Pipeline displays the last completed scan and any saved error.

Apply `supabase/migrations/202611020002_messenger_stage_history.sql` before deploying. It adds ordering metadata, an event ledger, smart-tag capture and a Page scan lease. It backfills smart tags only from recorded stage decisions and never deletes existing tags, changes chatbot enablement, or sends customer messages. Expired or revoked Facebook access requires a Page administrator to reconnect the Page; deployment cannot grant Page access.
