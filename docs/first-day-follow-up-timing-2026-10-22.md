# Original first-day follow-up timing

New clients who remain silent after the first chatbot answer use computed opportunities inside the original 24 elapsed hours. The owner selected the experimental spacing after reviewing the Azshinari timing audit. Exact gap parameters are manual operating settings; historical fitting did not validate an optimal personalized schedule or maximum useful count.

The first opportunity is the latest of the original inquiry plus 45 minutes, the delivered initial answer plus 30 minutes, the last outbound plus 30 minutes, and the current time. Later gaps are bounded to 120–360 minutes using 180 × 1.5^(k−2), where k is the reminder number starting at two. Opportunities move into 08:00–21:00 Manila time and must precede the original inquiry plus 24 hours minus ten minutes. Positive gaps and the deadline bound the count; there is no separate message-count cap.

For a prompt answer to a 09:00 inquiry, opportunities are 09:45, 12:45, 17:15 and 08:00 the next day. An 08:00 inquiry has three opportunities. A late initial answer shifts the first opportunity. Actual delivery timestamps shift later opportunities, preventing several overdue reminders from being sent together. A customer return ends the cold sequence; existing conversation replies and later-day settings remain available.

The first-day anchor is the contact's original recorded interaction, not the latest incoming message. Unknown original timestamps do not start this sequence. Opt-outs, refusals, holds, staff ownership, terminal stages, Page switches, trial restrictions, epoch/revision checks and Messenger eligibility remain enforced. The existing AI validation and duplicate-copy checks require a contextual next message.

The dashboard exposes fixed versus adaptive first-day timing. Older dashboard clients preserve the stored mode when saving other settings. Day 2–7 settings remain separately configured.

Apply the additive migration before deployment. It defaults existing configurations to fixed, adds job timing context and permits a distinct first_day_adaptive job purpose. Activate only after the updated production application is ready. The release script previews by default, backs up scoped settings/jobs before activation, preserves enable switches and delivery history, and replaces eligible pending first-day fixed jobs. It skips in-flight deliveries and does not invoke a worker or send messages.

Validation includes contact-reply cancellation, first-day expiry, late answers, waking boundaries, actual-send spacing, carried delivery history, idempotency, mode changes during generation, and existing handoff checks. A scratch-schema check exercises migration idempotency and constraints and then rolls back.

Release checks: 966 tests passed across 94 files. TypeScript, scoped ESLint and the production build passed. The existing configuration revision trigger advances on timing-mode changes, so activation carries matching pending jobs to the new revision to preserve later-day behavior.

The production release is ready on veochatbot.vercel.app. Authenticated API read-back passed on all 12 configured Pages, the deployed dashboard exposes the timing mode, the signed empty webhook check passed, and the cron route remains protected. Existing switches were preserved: SAMA KANA MEDIA is enabled and Azshinari remains disabled. There were zero eligible active first-day clients to migrate. No test customer messages or worker invocations were used for verification. OpenRouter credits were depleted at release, so actual generated follow-up delivery remains dependent on restoring provider credits.

Production rollout and verification receipts are stored outside Git in the parent workspace's ignored data directory. Customer histories, access tokens and historical analysis exports are not committed.
