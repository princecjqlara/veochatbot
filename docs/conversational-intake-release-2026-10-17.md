# Conversational intake messages

Commercial-video form introductions now use three ordered Messenger bubbles when automatic splitting is enabled: a short answer with one relevant question, the intact four-field form, then a free concept or free script offer. While the customer completes the form, an answer and its next question can use two short bubbles. Known details are preserved and the full form is not repeated after partial answers. Completed handoffs and customer opt-outs retain their existing behavior.

The renderer and downstream formatting retain the form and final offer without truncation. Explicit bubble limits and disabled splitting remain supported. Conversational copy retains its length budget. The dashboard describes the new flow and follow-up previews preserve the same message boundaries used for delivery.

Regression coverage now checks the three-bubble delivery order, cancellation of remaining bubbles when staff takes over, reset chats encountering historical Not qualified notices, delayed versus new stage echoes, and old-stage handling in follow-ups and background scans. Ordinary inbound messages do not reset durable staff outcomes. These checks protect the explicit owner-reset behavior deployed in the earlier Manawari repair.

Validation: 742 tests across 84 files pass. TypeScript, targeted ESLint, and the production build pass; existing unrelated dashboard warnings remain. Live knowledge-backed reply and follow-up previews passed for all 12 related Pages. Existing Page switches and follow-up schedules were preserved; this release requires no database migration.

Deployment `dpl_8UqHdAVMqQ858ioqQiMuqDeyRkQz` is promoted to `https://veochatbot.vercel.app`. Production webhook verification, signed empty webhook processing, and dashboard availability pass. The production preview endpoint confirms Manawari's three-message introduction, a two-message partial-answer reply, and a two-message follow-up without a repeated form. These previews send no Messenger messages and do not reset contacts.

`scripts/verify-conversational-intake-release.mjs` repeats the production preview checks using an existing authorized Page membership. Evidence is saved in the parent workspace's ignored `data/conversational-intake-production-check.json`. The deployment and test logs are in `data/manawari-split-*`. No Git commit or push was performed.
