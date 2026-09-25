# VeoBot - Facebook Page Management

A Next.js application for managing Facebook Page contacts, tags, messaging campaigns, and an AI-powered Messenger chatbot.

The chatbot includes a per-Page RAG knowledge base for grounding replies in business information and uploaded photos/videos.

<!-- Last updated for Vercel deployment - Redeploy trigger -->

## Features

- 🔐 Facebook OAuth authentication
- 📱 Connect and manage multiple Facebook Pages
- 👥 Contact management with bulk operations
- 🏷️ Tag management for organizing contacts
- 📨 Campaign creation and bulk messaging
- 🔄 Automatic contact synchronization via webhooks
- 📊 Dashboard with statistics and insights

## Tech Stack

- **Framework:** Next.js 14.1.0 (App Router)
- **Authentication:** NextAuth.js
- **Database:** Supabase
- **Styling:** Tailwind CSS
- **Icons:** Lucide React

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Supabase account
- Facebook App credentials

### Installation

1. Clone the repository:
```bash
git clone https://github.com/princecjqlara/veochatbot.git
cd veochatbot
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
Create a `.env` file in the root directory:
```env
# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key

# Facebook OAuth
FACEBOOK_CLIENT_ID=your-facebook-app-id
FACEBOOK_CLIENT_SECRET=your-facebook-app-secret
FACEBOOK_APP_SECRET=your-facebook-app-secret

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

# AI chatbot
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=~deepseek/deepseek-flash-latest
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
OPENROUTER_MULTIMODAL_MODEL=google/gemini-3.8-flash
CHATBOT_RAG_MATCH_THRESHOLD=0.35

# Optional private Google Drive indexing. Public-link folders need no credentials.
GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL=drive-reader@your-project.iam.gserviceaccount.com
GOOGLE_DRIVE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
# GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=replace-with-a-random-secret-token
TELEGRAM_MEDIA_ROUTES={"-1001234567890":"00000000-0000-4000-8000-000000000000"}

```

### Telegram group media bridge

VeoBot can automatically import supported photos and videos from approved Telegram groups into a Page's chatbot media library and RAG knowledge.

1. Create a bot with BotFather and add it to the source group. Make the bot an administrator or disable privacy mode so it receives group media messages.
2. Set `TELEGRAM_BOT_TOKEN` and generate a random `TELEGRAM_WEBHOOK_SECRET` containing only letters, numbers, `_`, and `-`.
3. Set `TELEGRAM_MEDIA_ROUTES` to a JSON object whose keys are Telegram chat IDs and values are VeoBot Page UUIDs. Only mapped groups are accepted.
4. Register the webhook after the public app URL is available:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_DOMAIN/api/telegram/webhook","secret_token":"YOUR_TELEGRAM_WEBHOOK_SECRET","allowed_updates":["message","channel_post"]}'
```

The bridge accepts the same formats as the chatbot media library and enforces its configured per-file limit. Telegram `file_unique_id` values provide duplicate protection. Files are stored privately in Supabase, analyzed, indexed, and made available for relevant Messenger replies.

5. Set up the database:
Run the SQL schema from `database/schema.sql` in your Supabase SQL editor.
Then run `database/migration_database_retention.sql` to install bounded campaign-history retention and automatic database maintenance.
For production, also run `database/migration_database_control_plane.sql` to add schema-version tracking, database health snapshots, integrity constraints, and maintenance observability.
Run `database/migration_conversation_export_jobs.sql` to enable durable background conversation exports and the Exports download page.
Run `database/migration_chatbot.sql` to install per-Page chatbot settings, reply idempotency, and chatbot message attribution.
Existing Supabase projects should apply `supabase/migrations/202609210003_chatbot_knowledge_rag.sql` to add the pgvector knowledge base. The main `database/schema.sql` already includes it for fresh installations.
Apply `supabase/migrations/202609210004_chatbot_sales_flow.sql` after it to add seven-day contact state, collected lead details, split-message settings, and durable stop reasons.
Apply `supabase/migrations/202609210005_chatbot_media_rag.sql` next to add page-scoped photo/video assets linked to RAG.
Apply `supabase/migrations/202609210006_chatbot_natural_bubbles.sql` and `202609210007_chatbot_rules_and_detail_target.sql` to enable automatic bubble counts, percentage-based detail targets, and per-Page allowed/prohibited behavior rules.
Apply `supabase/migrations/202609210008_chatbot_follow_up_scheduler.sql` to add durable first-day and best-time follow-up jobs, optional follow-up media, and day 2–7 utility-template settings.
Apply `supabase/migrations/202609210009_chatbot_human_agent_drafts.sql` next, then `202609210010_chatbot_ai_follow_up_content.sql` to add per-Page AI follow-up instructions and RAG-selected media on individual follow-up jobs.
Apply `supabase/migrations/202609220001_chatbot_direct_human_agent_follow_ups.sql` last to send day 2–7 follow-ups directly through HUMAN_AGENT and convert queued drafts into pending automatic sends.
Apply `supabase/migrations/202609230001_chatbot_drive_folders.sql` to add Page-scoped Google Drive media folders that the chatbot can retrieve and share using personalized Messenger buttons.
Apply `supabase/migrations/202609240001_chatbot_drive_files.sql` and `202609240002_disable_drive_folder_fallback.sql` to index individual Drive images/videos and prevent the bot from sending an entire folder as a fallback.
Apply `supabase/migrations/202609240003_chatbot_media_source_paths.sql` to preserve uploaded folder/file paths for AI retrieval.
Apply `supabase/migrations/202609240004_chatbot_drive_file_paths.sql` to preserve public Drive folder categories while indexing link-only media.
High-volume installations can then run `database/migration_compact_contact_interactions.sql` and its finalize migration to replace unbounded raw interaction events with compatible hourly counters.

For large campaigns, deploy the compact delivery queue in this exact order:

1. Run `database/migration_compact_campaign_delivery_prepare.sql`. It is additive and safe with the older sender.
2. Deploy the application code that uses atomic recipient claims and batch completion RPCs.
3. Confirm the new deployment is healthy, then run `database/migration_compact_campaign_delivery_finalize.sql` once. The finalizer preserves campaign totals and failures, removes completed one-time queue rows, and replaces the random recipient UUID with the `(campaign_id, contact_id)` primary key.
4. Run `database/migration_campaign_delivery_timeout_fix.sql` to make immediate claims and progress checks constant-time for fully materialized one-time campaigns.

Do not run the finalizer before step 2. Older senders calculate progress from terminal queue rows that the finalizer intentionally removes.

6. Run the development server:
```bash
npm run dev
```

7. Open [http://localhost:3000](http://localhost:3000) in your browser.

### Add chatbot knowledge

1. Open **Dashboard → AI Chatbot** and select a Facebook Page.
2. In **Knowledge base**, paste business information or load a `.txt`, `.md`, `.csv`, or `.json` file (up to 1 MB / 100,000 characters).
3. Give it a title and click **Add to knowledge base**. VeoBot chunks and embeds the text automatically.
4. Keep **Use knowledge base (RAG)** enabled, save the chatbot settings, and use **Test chatbot** to verify the answer and its matched sources.

Knowledge and retrieval are isolated by Page. Deleting a source also removes its stored vector chunks.

### Add chatbot photos and videos

1. In **Dashboard → AI Chatbot**, select the Facebook Page that owns the media.
2. Under **Photos and videos**, choose individual files or **Choose entire folder**. VeoBot preserves folder/file names, accepts up to 100 supported media files per batch and up to 50 MB per file, then adds every file to Page-scoped RAG.
3. Click **Upload and auto-RAG**. VeoBot stores the file privately, analyzes its visual/spoken content with the configured multimodal model, and indexes the analysis in that Page's knowledge base.
4. When the retrieved media is directly relevant, the bot can send one linked image or video after its text reply. The model can only select media returned by page-scoped RAG.

One VeoBot installation can operate all connected Pages. Each Page has separate instructions, on/off state, knowledge, media, contact state, and Page name in its AI context; use the Page selector to configure or disable them independently.

### Add large Google Drive media folders

1. Set the root folder and nested content to **Anyone with the link → Viewer**.
2. In **Dashboard → AI Chatbot → Knowledge**, enter the folder name, shared folder link, customer-facing button text, and guidance describing the samples and when each kind should be shared.
3. Click **Add folder to chatbot**, or **Sync files** for an existing folder. VeoBot recursively reads the public folder index and stores only filenames, folder categories, thumbnails, direct links and RAG embeddings. Video binaries remain in Google Drive.
4. When a sample is relevant, the bot selects only the matching file. One result appears as a single Messenger card; multiple results appear as a swipeable carousel. The whole folder is never sent as a fallback.

Public folders require no Google API or service-account credentials. For a private folder, configure the optional service-account variables and share the folder with that account as Viewer.

This approach supports files larger than Messenger's attachment ceiling because Messenger sends a link button to the selected Drive file rather than uploading it as a native attachment.

### Upload media folders without Google Drive

Use **Dashboard → AI Chatbot → Knowledge → Photos and videos → Choose entire folder** for the recommended no-Google setup. Files are stored privately in the existing Supabase Storage project. Folder paths, filenames, shared guidance and optional visual analysis are indexed so the bot selects only relevant files. A single match is sent as one Messenger card; multiple matches are sent as a carousel. Card buttons use a stable VeoBot URL that creates a short-lived private Storage link when opened.

Set `PUBLIC_APP_URL` to the public HTTPS application origin in production. It defaults to `NEXTAUTH_URL` when omitted.

### Configure the sales conversation flow

The **AI Chatbot** page also supports a controlled lead-qualification flow:

- Add a follow-up prompt that explains how the bot should qualify the customer.
- List the details to collect, one per line. VeoBot remembers values already provided and asks for one missing item at a time.
- Set a collection target from 1–100%. For example, 40% with five listed details stops collection after two are received, using the list order as priority.
- Add explicit **Bot should** and **Bot should not** rules for tone, allowed actions, prohibited claims, discount limits, and handoff behavior.
- Enable natural message bubbles to let VeoBot choose however many short Messenger messages the reply naturally needs, with no fixed bubble-count cap.
- Choose automatic stop rules for completed details, opt-out requests, purchase refusals, Meta Qualified / Not Qualified / Converted stages, and Messenger order creation.
- Enable automated no-reply follow-ups and configure aggressive first-day delays such as 10, 60, 240, 720, and 1,380 minutes. These sends use Messenger's standard `RESPONSE` window and are cancelled when the customer replies or the conversation stops.
- Configure days 2–7 at the contact's learned best hour (or noon Philippine time when there is not enough history). VeoBot sends the AI-personalized message directly through the Messenger Human Agent flow.
- Use **AI follow-up instructions** to describe how every follow-up should be written and when the AI should include retrieved media, such as previous work, product photos, testimonials, or promotional videos. Each job is generated from that contact's own conversation and Page-scoped RAG context.
- Select an uploaded photo or video to attach to the first eligible first-day follow-up.
- Bot state uses a rolling seven-day activity window from the customer's latest message. First-day follow-ups use `RESPONSE`; day 2–7 follow-ups are sent automatically with `HUMAN_AGENT` and are cancelled before the seven-day boundary.

Meta stage and order stops are detected by the existing messaging auto-tag cron worker. Keep `/api/cron/follow-up-automations` scheduled so those conversation-history signals are processed.

## Facebook Setup

See `FACEBOOK_SETUP.md` for detailed instructions on setting up Facebook OAuth and webhooks.

## Project Structure

```
src/
├── app/
│   ├── api/              # API routes
│   ├── dashboard/       # Dashboard pages
│   ├── error.tsx        # Error boundary
│   ├── global-error.tsx # Global error boundary
│   └── not-found.tsx   # 404 page
├── components/          # React components
├── lib/                 # Utility functions
└── types/               # TypeScript types
```

## Development

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## Deployment

### Vercel Deployment

1. Push your code to GitHub (already done)
2. Go to [Vercel](https://vercel.com) and sign in with GitHub
3. Click "New Project" and import your repository: `princecjqlara/veochatbot`
4. Configure environment variables in Vercel dashboard:
   - `NEXTAUTH_URL` - Your Vercel deployment URL (e.g., `https://your-app.vercel.app`)
   - `NEXTAUTH_SECRET` - Generate a random secret
   - `FACEBOOK_CLIENT_ID` - Your Facebook App ID
   - `FACEBOOK_CLIENT_SECRET` - Your Facebook App Secret
   - `FACEBOOK_APP_SECRET` - Your Facebook App Secret
   - `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Your Supabase anon key
   - `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key

5. Update Facebook App settings:
   - Add your Vercel URL to Facebook App redirect URIs:
     - `https://your-app.vercel.app/api/auth/callback/facebook`
   - Update webhook URL to:
     - `https://your-app.vercel.app/api/facebook/webhook`

6. Deploy! Vercel will automatically build and deploy your app.

### cron-jobs.org Setup

Vercel Cron is not used. Configure cron jobs in [cron-jobs.org](https://cron-jobs.org) to call the deployed API routes:

- Contact/name sync, every 30 minutes: `https://your-app.vercel.app/api/cron/sync`
- Scheduled campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-scheduled`
- Loop campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-loop`
- Follow-up automations, every minute: `https://your-app.vercel.app/api/cron/follow-up-automations`
- Conversation export worker, every minute: `https://your-app.vercel.app/api/cron/exports`

Use `GET` requests. These cron routes do not require a cron secret.

**Note:** The `vercel.json` file is configured with extended function timeouts (5 minutes) for sync operations, but does not define Vercel Cron schedules.

## License

Private project

## Repository

https://github.com/princecjqlara/veochatbot

