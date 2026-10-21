# Interactive video intake

Proceed questions now include a Fill out form postback button. Clicking it opens one complete, prefilled form followed by a separate missing-field question. A form click or completed form does not create production consent; an explicit paid-video, free-concept or free-script request is still required for handoff. Earlier saved location and goal keys remain compatible.

The customer-facing form is:

```text
Kindly fill out these details:

Business Name:
Page / Social Media Link:
Location:
Goal ng Video:
Preferred Video Length:
Preferred Style:
Contact Number:
Portrait or Landscape?
```

Video-length questions include 16s, 20s, 24s, 30s and 1 min quick replies. Other typed lengths remain supported. The selected main-video length is retained and prefilled rather than asked again. Choices represent preferences; prices still come from the existing knowledge and require confirmation when unavailable. Orientation questions include portrait and landscape choices. These controls are application-owned and cannot be invented by the language model.

Test Chat renders and handles the same button payloads through the preview endpoint. Actual selected sample cards/carousels appear before their final question; simulated carousel demonstrations stay out of model history. Reply and follow-up previews preserve separate bubbles and intact pricing, process and form messages. No test preview sends Messenger messages, resets contacts or schedules reminders.

Migration 20261021_002 updates the database missing-field validator and the new form-version stamp without reopening accepted requests or changing staff holds, messaging windows, review times or schedules. The rollout updates saved prompt copies and required fields on the existing 12 configurations while preserving their on/off state, knowledge routing, sample library, customer answers and reminder timing. Only SAMA KANA MEDIA is authorized to remain enabled.

Validation: 904 unit/integration tests, TypeScript, scoped ESLint, the real-model five-turn preview and real PostgreSQL scratch-schema checks passed. SQL verification rolls back its scratch transaction, including checks that accepted requests and explicit holds remain stopped. Production verification uses `node --env-file=.env.local --import=tsx scripts/verify-interactive-chatbot-release.mjs` to exercise duration and form clicks, the full form, follow-up preview, orientation choices and explicit handoff without sending customer messages.

Rollout commands, from the project directory with existing credentials:

- `node --env-file=.env.local --import=tsx scripts/release-form-summary-policy.mjs --apply-schema --transaction-pooler` applies the schema and previews prompt changes.
- Deploy the validated application commit to Vercel production.
- `node --env-file=.env.local --import=tsx scripts/release-form-summary-policy.mjs --apply --transaction-pooler` synchronizes the saved prompts and eight required fields with an external backup.
- `node --env-file=.env.local --import=tsx scripts/verify-form-summary-policy.mjs --enabled-page 838ba6f7-7d6d-4f5e-a7cd-11374960d0b7 --transaction-pooler` checks saved copies, preserved configuration and the one enabled Page.

Transport follows Meta's [Messenger quick-reply format](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api). Interactive options are added to the relevant question, keeping the full pricing/process/form text outside short button-template limits.
