# Business, sample, duration, pricing, process and form

This records the initial release. See [the final double-check record](conversation-flow-double-check-2026-10-21.md) for the latest deployment, saved-policy synchronization and 885-test verification.

The commercial-video bots now ask about the business, select one relevant existing portfolio sample, ask duration, send the applicable pricing and complete production process, ask whether the customer wants to proceed, then introduce the four-field form. Direct questions are answered at any point. Explicit requests for the form or the existing free concept/script options can proceed directly to intake.

Pricing stays in one complete message. All seven process steps and the revision note stay in a second complete message. The entire form stays in one message, prefilled with known answers. A relevant question follows the structured response. These blocks survive the old character and message-part limits, including when sentence splitting is disabled. Sample cards arrive before their final follow-up question, with delivery guards checked again before that question.

The process includes PHP150 initial down payment, business details and references, script approval before production, watermarked preview, final payment after approval, and unwatermarked final video plus free poster ads after full payment. PHP100 revisions apply only to additions outside the approved script after video completion.

Replies use natural Taglish and the saved first name, without emojis, surnames or titles. Unknown names are not invented. Existing answers and corrections are retained. The same Business Name, Business Location, Goal ng video and Contact Number remain required. The bot does not infer the video goal from a business type or service request. Partial answers lead to one missing-field question, without another blank form. Full summaries appear once unless corrected or requested again.

The knowledge document and sample library were retained. Applicable table rates are read from the existing knowledge rather than copied into source code. Main-video duration and short add-ons are labeled separately. Historical/reference rates require team confirmation before payment. Free concept/script requests remain free and are not purchase agreements.

All 855 tests passed across 87 files. TypeScript, scoped ESLint and the local production build passed. The Vercel production build passed. Real-model previews used the saved configuration, current knowledge and an existing bakery video. Authenticated previews passed all five turns on the staged deployment and the promoted production domain, including sample selection, intact pricing and process, prefilled form, explicit goal collection and final handoff. Production webhook handshake, signed empty webhook and dashboard checks passed.

Deployment dpl_3s1thHvA9Apa4TAQASnJdikvtySm is Ready and promoted to https://veochatbot.vercel.app. Previous deployment: dpl_HLPwFngQhp9j5XMEZLcHD3GwbZFT. Promotion used the explicit bigclicklara-2607s-projects scope.

Saved policy marker: Business sample duration and single-message sales policy (2026-10-21):. All five prompt fields and the fallback were updated and verified on all 12 Pages within their limits. Original settings were backed up in the parent workspace data directory before the transaction. The read-back verified unchanged knowledge routing, other configuration, schedules and stop rules, with no stale eligible reminder revisions.

All 12 bot switches and all 12 inbound-recovery switches remain OFF, with no queued, processing or manual-ready chatbot reminders. No contacts were reset. Previews and health checks sent no customer messages. Do not reactivate bots without an explicit owner request.

Current verification commands, run from the project directory with the existing environment:

- node --env-file=.env.local --import=tsx scripts/preview-sales-conversation.mjs
- node --env-file=.env.local --import=tsx scripts/verify-sales-conversation-release.mjs
- node --env-file=.env.local --import=tsx scripts/verify-form-summary-policy.mjs --expect-disabled
- node --env-file=.env.local scripts/verify-chatbot-release.mjs

For a protected staged deployment, the production preview accepts --origin followed by its URL and --vercel-curl to authenticate through the existing Vercel CLI session. Tokens are never written to the report.

Rollback application code to the previous deployment if needed. Restore only the changed prompt and fallback fields from the matching pre-update settings backup; preserve newer customer answers, stop rules and sent-message checkpoints. Do not replay cancelled reminders or reenable bot switches as part of rollback. No Git commit or push was performed.
