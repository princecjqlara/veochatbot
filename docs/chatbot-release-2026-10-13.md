# Messenger tagging, follow-up stops, and dashboard indexes

Messenger outcome changes now assign their matching tags through the shared pipeline helper, including confirmations of an unchanged stage. Positive outcomes preserve the existing combined paid-tag behavior. Outcome definitions and creation are shared with the periodic worker. Tag failures do not undo a persisted bot stop.

When the follow-up worker detects a live stop or saved staff ownership, it cancels the contact's remaining queued sequence. It repeats that check after generation so a handoff arriving while the AI is working also cancels future jobs.

`supabase/migrations/202610130001_dashboard_query_indexes.sql` adds a Page index matching the unfiltered pipeline sort and a partial Page/send-time index for chatbot outbound events. The first avoids loading every Page contact to return 25 rows; the second avoids scanning campaign deliveries for bot analytics. Production application can create the same indexes concurrently before recording the migration version.

Validation: 555 tests across 77 files passed, plus TypeScript and targeted ESLint. Temporary database copies verified identical pipeline rows and analytics totals before and after the indexes, with reduced query work. Temporary-copy timings do not predict production response times. No customer messages are required for deployment verification.
