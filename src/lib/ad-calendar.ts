const DAY = 86400000;
export const phtDay = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
export function calendarRange(month: string, now = Date.now()) {
 if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw Error('Choose a valid month between 2000 and 2099');
 const [year, number] = month.split('-').map(Number), from = Date.UTC(year, number - 1, 1) - 8 * 3600000, to = Date.UTC(year, number, 1) - 8 * 3600000;
 return { month, from: new Date(from).toISOString(), to: new Date(to).toISOString(), today: phtDay(now),
  days: Array.from({ length: Math.round((to - from) / DAY) }, (_, index) => phtDay(from + index * DAY)) };
}
export function shiftCalendarMonth(month: string, offset: -1 | 1) {
 const [year, number] = month.split('-').map(Number);
 return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
}
export function calendarInquiryCount(row: { inquiries: number; unattributed_inquiries: number }, adId = '') {
 return row.inquiries + (adId ? 0 : row.unattributed_inquiries);
}
const key = (page: string, ad: string | null) => JSON.stringify([page, ad]);
const count = (value: any) => { const n = Number(value || 0); if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid or unsafe report counts'); return n; };
const numeric = (value: any) => { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw Error('Invalid or unsafe delivery values'); return n; };
const ratio = (a: number | null, b: number | null) => a != null && b != null && b > 0 ? a / b : null;
const fields = ['inquiries', 'converted', 'converted_later', 'conversion_time_unknown', 'orders', 'payers', 'payers_later', 'confirmed_payers', 'confirmed_payers_later', 'chat_confirmed_payers', 'reviewed_conversations', 'confirmation_stale', 'legacy_dates', 'pre_inquiry_payments'] as const;
const delivery = ['impressions', 'clicks', 'link_clicks', 'messaging_started', 'video_plays', 'video_thruplays', 'video_complete'] as const;
function bucket() {
 return { inquiries: 0, converted: 0, converted_later: 0, conversion_time_unknown: 0, orders: 0, payers: 0, payers_later: 0, confirmed_payers: 0, confirmed_payers_later: 0, chat_confirmed_payers: 0, reviewed_conversations: 0, confirmation_stale: 0, legacy_dates: 0, pre_inquiry_payments: 0,
  stage_lags: [0, 0, 0, 0, 0], paid_lags: [0, 0, 0, 0, 0], confirmed_paid_lags: [0, 0, 0, 0, 0], finance: new Map<string, any>(),
  expected: 0, covered: 0, known: new Map<string, number>(), mismatched: 0, conflicting: 0, checked: [] as string[], timezones: new Set<string>(), reach: null as number | null,
  delivery: Object.fromEntries(delivery.map(field => [field, { known: 0, total: 0 }])) as Record<(typeof delivery)[number], { known: number; total: number }> };
}
type Bucket = ReturnType<typeof bucket>;
function addGroup(target: Bucket, group: any) {
 for (const field of fields) target[field] += count(group[field]);
 for (let index = 0; index < 5; index++) { target.stage_lags[index] += count(group.stage_lags?.[index]); target.paid_lags[index] += count(group.paid_lags?.[index]); }
 for (let index = 0; index < 5; index++) target.confirmed_paid_lags[index] += count(group.confirmed_paid_lags?.[index]);
 for (const row of group.finance || []) {
  if (!/^[A-Z]{3}$/.test(row.currency)) throw Error('Invalid payment currency');
  const value = target.finance.get(row.currency) || { currency: row.currency, received_minor: 0, refunded_minor: 0, records: 0, paid_orders: 0, salary: 0 };
  for (const field of ['received_minor', 'refunded_minor', 'records', 'paid_orders']) { value[field] += count(row[field]); if (!Number.isSafeInteger(value[field])) throw Error('Financial totals exceed the supported range'); }
  // Calculate the allowance at the stable acquisition-day/creative unit so
  // monthly totals equal their day/creative components without negative payroll credits.
  value.salary += Math.max(0, (count(row.received_minor) - count(row.refunded_minor)) / 100) * .4;
  target.finance.set(row.currency, value);
 }
}
function addSpend(target: Bucket, rows: any[], ad: any) {
 target.expected++;
 if (!rows.length) return;
 for (const row of rows) if (typeof row.account_timezone === 'string') target.timezones.add(row.account_timezone);
 if (rows.some(row => !row.pht_aligned)) { target.mismatched++; return; }
 const accounts = new Set(rows.map(row => row.account_id)), currencies = new Set(rows.map(row => row.currency));
 if (accounts.size !== 1 || currencies.size !== 1 || (ad.ad_account_id && !accounts.has(ad.ad_account_id))) { target.conflicting++; return; }
 const currency = rows[0].currency;
 if (!/^[A-Z]{3}$/.test(currency)) throw Error('Invalid ad-spend currency');
 const amount = rows.reduce((sum, row) => sum + numeric(row.amount), 0);
 target.covered++; target.known.set(currency, (target.known.get(currency) || 0) + amount);
 target.checked.push(...rows.map(row => row.checked_at).filter(Boolean));
 for (const field of delivery) if (rows.every(row => row[field] != null && (field !== 'messaging_started' || row.action_report_time === 'conversion' && row.attribution_setting === 'adset_unified'))) {
  target.delivery[field].known++; target.delivery[field].total += rows.reduce((sum, row) => sum + numeric(row[field]), 0);
 }
 if (target.expected === 1 && rows.length === 1 && rows[0].reach != null) target.reach = numeric(rows[0].reach); else target.reach = null;
}
function finish(value: Bucket) {
 const currencies = [...value.known.keys()], complete = value.expected > 0 && value.covered === value.expected && currencies.length === 1 && !value.mismatched && !value.conflicting;
 const spend = complete ? value.known.get(currencies[0])! : null, currency = currencies.length === 1 ? currencies[0] : null;
 const metrics = Object.fromEntries(delivery.map(field => [field, value.expected > 0 && value.delivery[field].known === value.expected ? value.delivery[field].total : null])) as Record<(typeof delivery)[number], number | null>;
 const finance = [...value.finance.values()].map(row => {
  const gross = (row.received_minor - row.refunded_minor) / 100;
  return { ...row, gross, after_salary: gross - row.salary, refunds_exceed_receipts: row.refunded_minor > row.received_minor };
 });
 const comparable = finance.length === 1 && finance[0].currency === currency && spend != null ? finance[0] : null;
 const profit = comparable ? comparable.after_salary - spend! : null;
 const totals = Object.fromEntries(fields.map(field => [field, value[field]])) as Record<(typeof fields)[number], number>;
 return { ...totals, conversion_rate: ratio(value.converted, value.inquiries), payer_rate: ratio(value.payers, value.inquiries), confirmed_payer_rate: ratio(value.confirmed_payers, value.inquiries),
  stage_lags: value.stage_lags, paid_lags: value.paid_lags, confirmed_paid_lags: value.confirmed_paid_lags, finance,
  spend: { amount: spend, currency, complete, expected_ad_days: value.expected, covered_ad_days: value.covered, timezone_mismatch: value.mismatched, account_conflicts: value.conflicting, account_timezones: [...value.timezones],
   recorded: [...value.known].map(([currency, amount]) => ({ currency, amount })), oldest_check: value.checked.slice().sort()[0] || null, newest_check: value.checked.slice().sort().at(-1) || null },
  ...metrics, reach: value.expected === 1 ? value.reach : null,
  frequency: value.expected === 1 ? ratio(metrics.impressions, value.reach) : null,
  ctr: ratio(metrics.clicks, metrics.impressions), link_ctr: ratio(metrics.link_clicks, metrics.impressions), cpc: ratio(spend, metrics.clicks), cpm: metrics.impressions ? ratio(spend, metrics.impressions / 1000) : null,
  cost_per_messaging: ratio(spend, metrics.messaging_started), cost_per_inquiry: ratio(spend, value.inquiries), cpa: ratio(spend, value.payers), confirmed_cpa: ratio(spend, value.confirmed_payers), cost_per_stage_conversion: ratio(spend, value.converted),
  profit, gross_roas: comparable ? ratio(comparable.gross, spend) : null, after_salary_roas: comparable ? ratio(comparable.after_salary, spend) : null, net_roas: ratio(profit, spend),
  financial_currency_mismatch: finance.length > 0 && currency != null && (finance.length !== 1 || finance[0].currency !== currency), financial_verified: finance.length > 0 };
}

export function buildAdCalendar(input: { month: string; now?: number; groups: any[]; spend: any[]; inventory: any[]; adId?: string | null; selectedDay?: string }) {
 const now = input.now || Date.now(), range = calendarRange(input.month, now), selectedDay = input.selectedDay || (range.today.startsWith(input.month) ? range.today : range.days[0]);
 if (!range.days.includes(selectedDay)) throw Error('Choose a day in the selected month');
 const ads = new Map(input.inventory.map(ad => [key(ad.page_id, ad.ad_id), ad]));
 for (const row of [...input.groups, ...input.spend]) if (row.ad_id && !ads.has(key(row.page_id, row.ad_id))) ads.set(key(row.page_id, row.ad_id), { page_id: row.page_id, ad_id: row.ad_id, ad_account_id: row.account_id || null });
 const selected = [...ads.values()].filter(ad => !input.adId || ad.ad_id === input.adId);
 const daily = new Map(range.days.map(day => [day, bucket()])), total = bucket(), unknown = new Map(range.days.map(day => [day, bucket()])), unknownTotal = bucket();
 const overallDays = new Map(range.days.map(day => [day, bucket()])), overall = bucket();
 const adTotals = new Map(selected.map(ad => [key(ad.page_id, ad.ad_id), bucket()])), adDays = new Map(selected.map(ad => [key(ad.page_id, ad.ad_id), bucket()]));
 for (const group of input.groups) {
  if (!daily.has(group.day)) continue;
  if (!input.adId || input.adId === 'unknown' && !group.ad_id || input.adId === group.ad_id) { addGroup(overallDays.get(group.day)!, group); addGroup(overall, group); }
  if (!group.ad_id) { addGroup(unknown.get(group.day)!, group); addGroup(unknownTotal, group); if (input.adId !== 'unknown') continue; }
  if (input.adId && input.adId !== 'unknown' && group.ad_id !== input.adId) continue;
  addGroup(daily.get(group.day)!, group); addGroup(total, group);
  if (group.ad_id) { const id = key(group.page_id, group.ad_id); if (adTotals.has(id)) { addGroup(adTotals.get(id)!, group); if (group.day === selectedDay) addGroup(adDays.get(id)!, group); } }
 }
 const spendRows = new Map<string, any[]>();
 for (const row of input.spend) { const id = JSON.stringify([row.page_id, row.ad_id, row.spend_date]); if (!spendRows.has(id)) spendRows.set(id, []); spendRows.get(id)!.push(row); }
 for (const ad of selected) for (const day of range.days) if (day <= range.today) {
  const rows = spendRows.get(JSON.stringify([ad.page_id, ad.ad_id, day])) || [], id = key(ad.page_id, ad.ad_id);
  addSpend(daily.get(day)!, rows, ad); addSpend(total, rows, ad); addSpend(overallDays.get(day)!, rows, ad); addSpend(overall, rows, ad); addSpend(adTotals.get(id)!, rows, ad); if (day === selectedDay) addSpend(adDays.get(id)!, rows, ad);
 }
 return { range, selected_day: selectedDay, generated_at: new Date(now).toISOString(), salary_rate: .4,
  summary: finish(total), overall: finish(overall), unattributed: finish(unknownTotal), days: range.days.map(day => ({ day, future: day > range.today, partial: day === range.today, ...finish(daily.get(day)!), overall: finish(overallDays.get(day)!), unattributed_inquiries: unknown.get(day)!.inquiries })),
  ads: selected.map(ad => ({ ...finish(adTotals.get(key(ad.page_id, ad.ad_id))!), ad })).sort((a, b) => b.inquiries - a.inquiries),
  day_ads: selected.map(ad => ({ ...finish(adDays.get(key(ad.page_id, ad.ad_id))!), ad })).sort((a, b) => b.inquiries - a.inquiries),
  inventory: [...ads.values()],
  definitions: { attribution: 'First verified originating ad and inquiry date. Later conversions, deposits, balances and refunds update that original cohort. Unknown sources receive no ad-spend allocation.',
   overall: 'The overall calendar includes unknown-source customers and their recorded receipts, deducting total imported Page ad spend once. Creative-specific returns include only that verified originating ad; unknown-source receipts are never allocated to a creative.',
   confirmations: 'Confirmed customers combine unique ledger payers and documented Page payment acknowledgements, counting an overlap once. Cached conversation evidence is dated at its source cutoff; newer activity is flagged. A chat acknowledgement does not create a verified cash amount or bank confirmation.',
   revenue: 'Verified receipts including deposits, minus refunds, from this cohort through the report time. Missing financial records are not assumed unpaid. Repeat receipts remain credited to the first origin.',
   salary: '40% of positive recorded revenue after refunds per acquisition-day/creative cohort, then added across cohorts. Refunds do not create negative payroll credits. This is a modeled allowance, not payroll verification; other expenses and taxes are excluded.',
   payers: 'Unique customers with a non-void verified receipt. Deposits and balances do not count as separate acquisitions. Refunds reduce revenue while retaining the acquisition history.',
   gross_roas: 'Recorded revenue after refunds / ad spend', after_salary_roas: '(Recorded revenue - 40% salary) / ad spend', net_roas: '(Recorded revenue - 40% salary - ad spend) / ad spend',
   messaging: 'Meta messaging conversations started, reported by conversion time using ad-set attribution. This is separate from unique VeoBot inquiry cohorts.',
   coverage: 'Calendar totals cover the recorded, verified Page ad inventory. Missing ad-days, currency conflicts or account-timezone mismatches prevent complete cost/profit ratios. Today is provisional.' } };
}

export function calendarHeat(value: number | null | undefined, scale: number) {
 if (value == null || !Number.isFinite(value)) return { backgroundColor: '#f1f5f9', color: '#64748b', borderColor: '#cbd5e1' };
 if (value === 0) return { backgroundColor: '#ffffff', color: '#334155', borderColor: '#e2e8f0' };
 const intensity = Math.max(.12, Math.min(1, Math.abs(value) / (scale || 1))), hue = value < 0 ? 0 : 140;
 const light = (96 - intensity * 61) / 100, chroma = (1 - Math.abs(2 * light - 1)) * .55, x = chroma * (1 - Math.abs((hue / 60) % 2 - 1)), m = light - chroma / 2;
 const channels = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
 const linear = channels.map(channel => { const v = channel + m; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
 const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
 return { backgroundColor: `hsl(${hue} 55% ${light * 100}%)`, color: luminance < .179 ? '#ffffff' : '#000000', borderColor: `hsl(${hue} 35% 70%)` };
}
