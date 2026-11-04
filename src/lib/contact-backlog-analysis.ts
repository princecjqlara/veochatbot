import { COMMERCIAL_VIDEO_FIELDS, normalizeCommercialVideoDetails } from './chatbot-intake';
import { conversationEvidence, groundedAnalysis, hoursBetween, mergeProfileFacts, type ExtractedAnswer, type ProfileFact, type ProfileMessage, type SummaryPoint } from './contact-profile-evidence';
import { parseMessengerStageEvent } from './messenger-stage-sync';
import { administrative } from './conversion-runtime/evidence.js';

export const BACKLOG_ANALYSIS_VERSION = 'local-evidence-v3';
type Input = { pageId: string; facebookPageId: string; psid: string; cutoff: string; messages: any[]; requestedFields?: string[]; commercialVideo?: boolean };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const placeholder = /^(?:unknown|n\/?a|none|null|undefined|pending|tbd|not provided|not sure|wala(?: pa)?|[-?]+)[.!?\s]*$/i;
const creative = /(?:^|\n)\s*(?:scene\s*\d|visuals?|dialogue|voice.?over|CTA|hook)\s*:/i;
const template = /^(?:\s*)(?:sample (?:form|answers?)|example (?:form|answers?)|for reference only|halimbawang form|template only)\b/im;
const shortAcknowledgment = /^(?:hi|hello|thanks|thank you|salamat|ok(?:ay)?|sige|yes|no|oo|opo|noted|hm|magkano|how much)[.!\s]*$/i;
const futurePurchase = /\b(?:will|would|want|planning|plan to|balak|gusto|magbibili|bibili|bibili pa|oorder|mag.order|if|kung|kapag|once)\b/i;
const categories: Record<string, string> = { 'Business Name': 'business', 'Page / Social Media Link': 'business', 'Business Location': 'business', 'Goal ng video': 'purpose', 'Preferred Video Length': 'preference', 'Preferred Style': 'preference', 'Contact Number': 'business', 'Portrait or Landscape?': 'preference' };
const generic = [
 { label: 'Purpose', category: 'purpose', aliases: ['purpose', 'objective', 'goal'] },
 { label: 'Preference', category: 'preference', aliases: ['preference', 'preferred package', 'preferred product', 'preferred service', 'preferred schedule'] },
 { label: 'Requirement', category: 'requirement', aliases: ['requirement', 'requirements', 'need', 'request'] },
 { label: 'Problem', category: 'problem', aliases: ['problem', 'issue', 'problema', 'concern'] },
 { label: 'Suggestion', category: 'suggestion', aliases: ['suggestion', 'feedback', 'recommendation'] },
 { label: 'Budget', category: 'requirement', aliases: ['budget'] }
];

export function backlogSourceMessages(input: Input): ProfileMessage[] {
 if (!Number.isFinite(Date.parse(input.cutoff)) || !Array.isArray(input.messages)) throw Error('A dated complete source is required');
 return [...new Map(input.messages.map(message => {
  if (typeof message.id !== 'string' || !message.id || !Number.isFinite(Date.parse(message.created_time)) || typeof message.message === 'string' && message.message.length > 50000) throw Error('Invalid or oversized source message');
  const attachments: any[] = Array.isArray(message.attachments?.data) ? message.attachments.data : [];
  const value: ProfileMessage = { id: message.id, at: new Date(message.created_time).toISOString(), text: typeof message.message === 'string' ? message.message : '',
   sender: message.from?.id === input.psid ? 'customer' : message.from?.id === input.facebookPageId ? 'page' : 'unknown',
   attachments: attachments.length, images: attachments.filter(item => !item.image_data?.render_as_sticker && (item.image_data || item.mime_type?.startsWith('image/'))).length };
  return [value.id, value] as const;
 })).values()].filter(message => Date.parse(message.at) <= Date.parse(input.cutoff))
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

export function verifyBacklogArtifact(artifact: any) {
 if (artifact.engine !== BACKLOG_ANALYSIS_VERSION || artifact.model !== BACKLOG_ANALYSIS_VERSION || artifact.processing_complete !== true || artifact.payload?.history_complete !== true || !Array.isArray(artifact.messages)) throw Error('Prepared profile version or completeness is invalid');
 const cutoff = Date.parse(artifact.source_cutoff_at), messages = new Map<string, ProfileMessage>();
 if (!Number.isFinite(cutoff) || !/^[0-9a-f]{64}$/.test(artifact.source_sha256 || '')) throw Error('Prepared source fingerprint or cutoff is invalid');
 for (const message of artifact.messages as ProfileMessage[]) {
  if (!message.id || messages.has(message.id) || !['customer', 'page', 'unknown'].includes(message.sender) || !Number.isFinite(Date.parse(message.at)) || Date.parse(message.at) > cutoff || typeof message.text !== 'string') throw Error('Prepared source messages are inconsistent');
  messages.set(message.id, message);
 }
 if (artifact.payload.conversation?.message_count !== messages.size) throw Error('Prepared message count does not match its sources');
 let citations = 0;
 const check = (item: any, customerOnly: boolean, literalValue: boolean) => {
  if (!Array.isArray(item.evidence) || !item.evidence.length) throw Error('Prepared statement has no source evidence');
  for (const proof of item.evidence) {
   const message = messages.get(proof.message_id);
    const quote = typeof proof.quote === 'string' ? proof.quote.trim() : '';
    const nonTextSummaryReference = !literalValue && (
     quote === '[image attachment]' && (message?.images ?? 0) > 0
     || quote === '[attachment]' && (message?.attachments ?? 0) > 0
     || quote === '[non-text message]' && !message?.text.trim()
    );
    if (!message || message.sender === 'unknown' || customerOnly && message.sender !== 'customer' || !quote || !message.text.includes(quote) && !nonTextSummaryReference || literalValue && !quote.includes(item.value)) throw Error('Prepared citation does not match its source or sender');
   citations++;
  }
 };
 for (const point of artifact.payload.summary_points || []) check(point, false, false);
 for (const fact of artifact.payload.facts || []) check(fact, !['purchase', 'promise'].includes(fact.category), true);
 for (const answer of [...artifact.payload.extracted_answers || [], ...artifact.payload.answer_history || []]) check(answer, true, true);
 for (const event of artifact.payload.timeline || []) if (!messages.has(event.message_id) || messages.get(event.message_id)!.at !== event.at) throw Error('Prepared timeline does not match its source time');
 const money = artifact.payload.verified_financial_data;
 if (!money || money.receipt_amounts_verified !== false || money.purchase_count !== null || money.gross_revenue !== null || money.payment_status !== 'not_verified') throw Error('Conversation analysis cannot create verified financial data');
 return { verified: true, citations_checked: citations, messages_checked: messages.size };
}

/** No model or network calls. Every extracted answer remains the customer's
 * literal wording; summaries describe source events rather than inferred sales. */
export function analyzeContactBacklog(input: Input) {
 const messages = backlogSourceMessages(input), source = new Map(messages.map(message => [message.id, message]));
 const fields = [
  ...COMMERCIAL_VIDEO_FIELDS.map(field => ({ label: field.label as string, category: categories[field.label], aliases: [field.label, field.displayLabel, field.key, ...field.aliases].filter(alias => input.commercialVideo || !['purpose', 'objective', 'duration', 'length', 'style', 'format'].includes(alias.toLowerCase())), commercial: true })),
  ...generic.filter(field => !input.commercialVideo || field.label !== 'Purpose').map(field => ({ ...field, commercial: false })),
  ...(input.requestedFields || []).filter(label => typeof label === 'string' && label.trim() && label.length <= 100)
   .map(label => ({ label, category: 'requirement', aliases: [label], commercial: false }))
 ].filter((field, index, all) => all.findIndex(other => other.label.toLowerCase() === field.label.toLowerCase()) === index);
 const answerHistory: Array<ExtractedAnswer & { at: string; basis: string; prompt_message_id?: string }> = [];
 const facts: ProfileFact[] = [], candidates: Array<{ category: string; message_id: string; quote: string; at: string; needs_review: true }> = [];
 const proof = (message: ProfileMessage, quote = message.text.slice(0, 1000)) => [{ message_id: message.id, quote }];
 const valid = (field: typeof fields[number], value: string) => value.length <= 500 && value.trim() &&
  (field.commercial ? Boolean(normalizeCommercialVideoDetails({ [field.label]: value })[field.label]) : !placeholder.test(value));
 const addAnswer = (field: typeof fields[number], value: string, message: ProfileMessage, basis: string, prompt?: ProfileMessage) => {
  if (!valid(field, value) || !message.text.includes(value)) return;
  const quote = message.text.length <= 1000 ? message.text : value;
  answerHistory.push({ field: field.label, value, evidence: proof(message, quote), at: message.at, basis, ...(prompt ? { prompt_message_id: prompt.id } : {}) });
  facts.push({ category: field.category, key: field.label, value, evidence: proof(message, quote) });
 };
 const questionText = new Map<string, string>();
 let previous: ProfileMessage | undefined;
 for (const message of messages) {
  if (message.sender !== 'customer' || creative.test(message.text) || template.test(message.text) || administrative(message.text)) { if (message.sender === 'customer') questionText.set(message.id, ''); previous = message; continue; }
  let explicit = false;
  const questionLines: string[] = [];
  for (const line of message.text.split(/\r?\n/)) {
   const text = line.trim().replace(/^\d+[.)]\s*/, '');
   let filledLine = false;
   for (const field of fields) {
    let found = false;
    for (const alias of [...new Set(field.aliases)].sort((a, b) => b.length - a.length)) {
     const match = new RegExp('^' + escape(alias) + (alias.endsWith('?') ? '\\s*:?' : '\\s*[:=]') + '\\s*(.+)$', 'iu').exec(text);
     if (!match) continue;
     const value = match[1].trim(); if (valid(field, value)) { addAnswer(field, value, message, 'explicit_customer_field'); explicit = true; filledLine = true; }
     found = true; break;
    }
    if (found) break;
   }
   if (!filledLine) questionLines.push(line);
  }
  questionText.set(message.id, questionLines.join('\n'));
  if (!explicit && previous?.sender === 'page' && previous.text.length < 600 && message.text.trim().length <= 500 && !/[?]/.test(message.text) && !creative.test(previous.text) &&
   !shortAcknowledgment.test(message.text.trim()) && hoursBetween(previous.at, message.at)! <= 24 && /\?|\b(?:provide|share|tell|ano|anong|pakibigay|ilagay)\b/i.test(previous.text)) {
   const prompted = fields.filter(field => field.aliases.some(alias => new RegExp('(?:^|[^\\p{L}\\p{N}])' + escape(alias.replace(/\?$/, '')) + '(?=$|[^\\p{L}\\p{N}])', 'iu').test(previous!.text)));
   // Multiple form questions do not identify which field a short reply answers.
   if (prompted.length === 1) addAnswer(prompted[0], message.text.trim(), message, 'reply_to_single_field_prompt', previous);
  }
  if (!/[?]/.test(message.text) && message.text.trim().length <= 1000) {
   for (const [category, pattern] of [
    ['problem', /\b(?:problem|issue|error|sira|reklamo|delay|not working|hindi gumagana)\b/i],
    ['suggestion', /\b(?:suggest|suggestion|recommend|feedback|sana)\b/i],
    ['objection', /\b(?:mahal|expensive|too much|cannot afford|di kaya|hindi kaya)\b/i],
    ['purchase', /\b(?:bought|purchased|bumili|umorder|nag.order)\b/i]
   ] as const) if (pattern.test(message.text) && !(category === 'purchase' && futurePurchase.test(message.text)) && !/\b(?:no problem|walang problema)\b/i.test(message.text))
    candidates.push({ category, message_id: message.id, quote: message.text, at: message.at, needs_review: true });
  }
  previous = message;
 }
 const latestAnswers = new Map<string, typeof answerHistory[number]>();
 for (const answer of answerHistory) latestAnswers.set(answer.field, answer);
 const conversation = conversationEvidence(messages);
 const questions = conversationEvidence(messages.map(message => message.sender === 'customer' ? { ...message, text: questionText.get(message.id) || '' } : message));
 conversation.questions = questions.questions; conversation.unique_question_count = questions.unique_question_count;
 const stageEvents = [...new Map(input.messages.map(message => [message.id, message])).values()].filter(message => Date.parse(message.created_time) <= Date.parse(input.cutoff)).map(message => parseMessengerStageEvent(message, input.facebookPageId)).filter((event): event is NonNullable<typeof event> => Boolean(event))
  .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.messageId.localeCompare(b.messageId));
 const firstConverted = stageEvents.find(event => event.stage === 'converted') || null;
 const acknowledgment = conversation.payment_evidence.find(event => event.acknowledgment) || null;
 const deposit = conversation.payment_evidence.find(event => event.acknowledgment && /\b(?:dp|down\s*payment|deposit)\b/i.test(event.quote)) || null;
 const fullPayment = conversation.payment_evidence.find(event => event.acknowledgment && event.kind === 'full_payment_ack') || null;
 const followUpCandidates = messages.filter(message => message.sender === 'page' && /\b(?:follow[ -]?up|following up|any update|may update|kamusta|kumusta)\b/i.test(message.text) && !administrative(message.text) &&
  conversation.first_inquiry_at && Date.parse(message.at) > Date.parse(conversation.first_inquiry_at)).map(message => ({ message_id: message.id, at: message.at, quote: message.text.slice(0, 1000), basis: 'Text pattern; delivery attribution not verified' }));
 const summary: SummaryPoint[] = [];
 const first = source.get(conversation.first_message_id || '');
 if (first?.text.trim()) summary.push({ text: 'Customer opening message: ' + first.text.trim().slice(0, 300), evidence: proof(first, first.text.slice(0, 1000)) });
 const priorities = ['Goal ng video', 'Purpose', 'Business Name', 'Preference', 'Preferred Video Length', 'Problem'];
 const rank = (field: string) => priorities.includes(field) ? priorities.indexOf(field) : 99;
 for (const answer of [...latestAnswers.values()].sort((a, b) => rank(a.field) - rank(b.field)).slice(0, 3))
  summary.push({ text: `${answer.field}: ${answer.value}`, evidence: answer.evidence });
 // Keep a useful, source-linked overview even when the conversation contains
 // no structured form answers. Questions and short customer excerpts are
 // quoted directly instead of being turned into unsupported AI-like claims.
 const summarized = new Set(summary.flatMap(point => point.evidence.map(item => item.message_id)));
 for (const question of conversation.questions.slice(0, 3)) {
  if (summary.length >= 7) break;
  const message = source.get(question.message_ids?.[0]);
  if (!message || summarized.has(message.id)) continue;
  const repeat = question.count > 1 ? ` (asked ${question.count} times)` : '';
  summary.push({ text: `Customer asked: ${question.text.slice(0, 300)}${repeat}`, evidence: proof(message, question.text.slice(0, 1000)) });
  summarized.add(message.id);
 }
 for (const message of messages.filter(item => item.sender === 'customer' && item.text.trim().length >= 20 && !administrative(item.text))) {
  if (summary.length >= 7) break;
  if (summarized.has(message.id)) continue;
  const quote = message.text.trim().slice(0, 300);
  summary.push({ text: `Customer said: ${quote}`, evidence: proof(message, quote) });
  summarized.add(message.id);
 }
 for (const message of messages.filter(item => item.sender === 'customer' && !item.text.trim())) {
  if (summary.length >= 7) break;
  if (summarized.has(message.id)) continue;
  const images = message.images ?? 0, attachments = message.attachments ?? 0;
  const reference = images ? '[image attachment]' : attachments ? '[attachment]' : '[non-text message]';
  const detail = images ? `shared ${images} image attachment${images === 1 ? '' : 's'}; image content was not interpreted`
   : attachments ? `shared ${attachments} attachment${attachments === 1 ? '' : 's'}; attachment content was not interpreted`
    : 'sent a non-text message; no message text was available to summarize';
  summary.push({ text: `Customer ${detail}.`, evidence: proof(message, reference) });
  summarized.add(message.id);
 }
 if (acknowledgment) summary.push({ text: 'The Page acknowledged a payment in chat. Bank receipt and cash amount remain separate checks.', evidence: [{ message_id: acknowledgment.message_id, quote: acknowledgment.quote }] });
 if (stageEvents.length) { const event = stageEvents.at(-1)!, message = source.get(event.messageId); if (message?.text) summary.push({ text: `Last Page stage notice in this saved history: ${event.label}.`, evidence: proof(message) }); }
 // The shared merger groups case/whitespace variants. Keep only citations that
 // contain the retained literal value; alternate spellings remain in history.
 const literalFacts = mergeProfileFacts([{ facts }]).map(fact => ({ ...fact,
  evidence: fact.evidence.filter(item => item.quote.includes(fact.value))
 })).filter(fact => fact.evidence.length > 0);
 const grounded = groundedAnalysis({ summary_points: summary.slice(0, 8), facts: literalFacts, answers: [...latestAnswers.values()] }, messages, fields.map(field => field.label));
 const validatedHistory = answerHistory.filter(answer => groundedAnalysis({ answers: [answer] }, messages, fields.map(field => field.label)).answers.length === 1);
 const timeline = [
  ...stageEvents.map(event => ({ type: 'page_stage_notice', at: event.occurredAt, message_id: event.messageId, label: event.label, stage: event.stage })),
  ...validatedHistory.map(answer => ({ type: 'customer_answer', at: answer.at, message_id: answer.evidence[0].message_id, field: answer.field, value: answer.value })),
  ...conversation.payment_evidence.map(event => ({ type: event.acknowledgment ? 'chat_payment_acknowledgment' : 'chat_payment_statement', at: event.at, message_id: event.message_id, kind: event.kind, amount_stated: event.amount, bank_verified: false }))
 ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
 const reviewReasons = [...(!messages.some(message => message.sender === 'customer') ? ['No dated customer messages were available'] : []), ...(messages.some(message => message.images) ? ['Image attachments were retained but not interpreted'] : []), ...(candidates.length ? ['Keyword-based statements need contextual review'] : []), ...(messages.some(message => message.sender === 'unknown') ? ['Some message senders are unknown'] : [])];
 return { model: BACKLOG_ANALYSIS_VERSION, messages, payload: {
  summary_points: grounded.summary_points, facts: grounded.facts, extracted_answers: grounded.answers, answer_history: validatedHistory,
  excluded_facts: grounded.excluded, conversation, history_complete: true, analysis_method: 'deterministic_source_extraction',
  source_description: 'Prepared from saved conversation text through its recorded cutoff. Explicit fields and source events are extracted; images and ambiguous statements need review.',
  review_candidates: candidates, review_reasons: reviewReasons, processing_complete: true, interpretation_coverage: 'Explicit fields and cited source events',
  stage_events: stageEvents, timeline, follow_up_candidates: followUpCandidates,
  observed_timing: { first_converted_notice_at: firstConverted?.occurredAt || null,
   inquiry_to_converted_notice_hours: hoursBetween(conversation.first_inquiry_at, firstConverted?.occurredAt),
   inquiry_to_payment_ack_hours: hoursBetween(conversation.first_inquiry_at, acknowledgment?.at),
   inquiry_to_deposit_ack_hours: hoursBetween(conversation.first_inquiry_at, deposit?.at),
   deposit_to_full_payment_ack_hours: hoursBetween(deposit?.at, fullPayment?.at),
   follow_up_candidates_before_first_ack: acknowledgment ? followUpCandidates.filter(event => Date.parse(event.at) < Date.parse(acknowledgment.at)).length : null,
   basis: 'Observed message/notice times, not bank settlement or verified purchase times' },
  verified_financial_data: { receipt_amounts_verified: false, purchase_count: null, gross_revenue: null, payment_status: 'not_verified' },
  suggested_history_tags: [...new Set(stageEvents.map(event => `History: ${event.label}`))]
 } };
}
