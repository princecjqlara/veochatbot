import { describe, expect, it } from 'vitest';
import { buildAdCalendar, calendarHeat, calendarInquiryCount, calendarRange, shiftCalendarMonth } from '@/lib/ad-calendar';
import { actionAmount, dailyDeliveryMetrics } from '@/lib/ad-daily-spend';
const now = Date.parse('2020-02-04T00:00:00Z'), ad = { page_id: 'p', ad_id: '11', ad_account_id: '22', ad_name: 'Creative' };
const group = { page_id: 'p', ad_id: '11', day: '2020-01-01', inquiries: 10, converted: 3, converted_later: 2, payers: 2, payers_later: 2,
 stage_lags: [1, 1, 1, 0, 0], paid_lags: [0, 1, 1, 0, 0], finance: [{ currency: 'PHP', received_minor: 50000, refunded_minor: 5000, records: 3, paid_orders: 2 }] };
const spend = { page_id: 'p', ad_id: '11', account_id: '22', spend_date: '2020-01-01', currency: 'PHP', amount: 100, pht_aligned: true, impressions: 1000, clicks: 50,
 link_clicks: 25, messaging_started: 20, reach: 800, action_report_time: 'conversion', attribution_setting: 'adset_unified' };
const build = (patch: any = {}) => buildAdCalendar({ month: '2020-01', now, groups: [group], spend: [spend], inventory: [ad], ...patch });

describe('acquisition-day ad economics', () => {
 it('reports all-source cohort returns without assigning unknown customers to a creative or counting a payer twice', () => {
  const unknown = { ...group, ad_id: null, inquiries: 5, confirmed_payers: 2, chat_confirmed_payers: 2, confirmed_payers_later: 2, finance: [{ currency: 'PHP', received_minor: 10000, refunded_minor: 0, records: 1, paid_orders: 1 }] };
  const result = build({ groups: [{ ...group, confirmed_payers: 2 }, unknown] });
  expect(result.overall.inquiries).toBe(15); expect(result.overall.confirmed_payers).toBe(4);
  expect(result.days[0].overall.confirmed_cpa).toBe(25); expect(result.days[0].overall.confirmed_payers_later).toBe(2);
  expect(result.overall.finance[0].gross).toBe(550); expect(result.days[0].overall.profit).toBe(230);
  expect(result.ads[0].inquiries).toBe(10); expect(result.ads[0].confirmed_payers).toBe(2); expect(result.day_ads[0].profit).toBe(170);
  const onlyUnknown = build({ adId: 'unknown', groups: [unknown] });
  expect(onlyUnknown.overall.inquiries).toBe(5); expect(onlyUnknown.overall.spend.amount).toBeNull(); expect(onlyUnknown.overall.profit).toBeNull();
 });
 it('keeps later outcomes in the original inquiry day and computes both conversion rates', () => {
  const day = build().days[0]; expect(day).toMatchObject({ inquiries: 10, converted: 3, converted_later: 2, conversion_rate: .3, payers: 2, payer_rate: .2 });
  expect(day.stage_lags).toEqual([1, 1, 1, 0, 0]); expect(build().days[1].inquiries).toBe(0);
 });
 it('deducts refunds, 40% salary and actual spend once; distinguishes gross, after-salary and profit ROAS', () => {
  const day = build().days[0]; expect(day.finance[0]).toMatchObject({ gross: 450, salary: 180, after_salary: 270 });
  expect(day).toMatchObject({ profit: 170, gross_roas: 4.5, after_salary_roas: 2.7, net_roas: 1.7, cpa: 50, cost_per_inquiry: 10, cost_per_messaging: 5, cpc: 2, cpm: 100, ctr: .05 });
 });
 it('does not turn a missing imported day or missing ledger into zero spend, unpaid status or invented profit', () => {
  const result = build(); expect(result.days[1].spend.amount).toBeNull(); expect(result.summary.spend.complete).toBe(false); expect(result.summary.profit).toBeNull();
  const day = build({ groups: [{ ...group, finance: [] }] }).days[0]; expect(day.financial_verified).toBe(false); expect(day.profit).toBeNull(); expect(day.gross_roas).toBeNull();
 });
 it('includes zero-lead creative spend instead of allocating it away to successful ads', () => {
  const result = build({ inventory: [ad, { ...ad, ad_id: '33' }], spend: [spend, { ...spend, ad_id: '33', amount: 50 }] });
  expect(result.days[0].spend.amount).toBe(150); expect(result.days[0].profit).toBe(120); expect(result.days[0].cpa).toBe(75);
 });
 it('keeps salary/profit totals additive across loss cohorts without inventing negative payroll credits', () => {
  const rows = calendarRange('2020-01', now).days.map(day => ({ ...spend, spend_date: day, amount: day === '2020-01-01' ? 100 : day === '2020-01-02' ? 10 : 0 }));
  const loss = { ...group, day: '2020-01-02', finance: [{ currency: 'PHP', received_minor: 0, refunded_minor: 10000, records: 1 }] };
  const result = build({ groups: [group, loss], spend: rows }); expect(result.summary.finance[0].salary).toBe(180);
  expect(result.summary.profit).toBe(60); expect(result.summary.profit).toBe(result.days[0].profit! + result.days[1].profit!);
 });
 it('separates unknown-source inquiries/revenue from ad-attributed returns', () => {
  const result = build({ groups: [group, { ...group, ad_id: null, inquiries: 50, converted: 20 }] });
  expect(result.days[0].inquiries).toBe(10); expect(result.days[0].unattributed_inquiries).toBe(50); expect(result.unattributed.inquiries).toBe(50);
  const unknown = build({ adId: 'unknown', groups: [{ ...group, ad_id: null }] }); expect(unknown.summary.inquiries).toBe(10); expect(unknown.summary.spend.amount).toBeNull();
 });
 it('never combines incompatible currencies, account ownership or account timezones for ROAS', () => {
  const foreign = build({ groups: [{ ...group, finance: [...group.finance, { currency: 'USD', received_minor: 1000, refunded_minor: 0, records: 1 }] }] }).days[0];
  expect(foreign.profit).toBeNull(); expect(foreign.financial_currency_mismatch).toBe(true);
  expect(build({ spend: [{ ...spend, pht_aligned: false }] }).days[0].spend.amount).toBeNull();
  expect(build({ spend: [spend, { ...spend, account_id: 'different' }] }).days[0].spend.amount).toBeNull();
 });
 it('shows known zero spend without infinite ROAS, and never sums reach into a fake unique audience', () => {
  const day = build({ spend: [{ ...spend, amount: 0 }] }).days[0]; expect(day.spend.amount).toBe(0); expect(day.cpa).toBe(0); expect(day.gross_roas).toBeNull(); expect(day.profit).toBe(270);
  expect(build().days[0].reach).toBe(800); expect(build().summary.reach).toBeNull();
 });
 it('builds real PHT month boundaries and marks future/current dates distinctly', () => {
  expect(calendarRange('2020-02', Date.parse('2020-02-10T00:00:00Z')).days).toHaveLength(29);
  expect(calendarRange('2020-01', now).from).toBe('2019-12-31T16:00:00.000Z');
  expect(() => calendarRange('2020-13', now)).toThrow(); expect(() => calendarRange('1999-01', now)).toThrow();
  const result = build({ now: Date.parse('2020-01-02T00:00:00Z') }); expect(result.days[1].partial).toBe(true); expect(result.days[2].future).toBe(true);
 });
});
describe('calendar browsing and inquiry coverage', () => {
 it('browses past and future months across year boundaries without inventing future activity', () => {
  expect(shiftCalendarMonth('2026-01', -1)).toBe('2025-12');
  expect(shiftCalendarMonth('2025-12', 1)).toBe('2026-01');
  const future = build({ month: '2030-02', groups: [], spend: [] });
  expect(future.days).toHaveLength(28); expect(future.days.every(day => day.future)).toBe(true);
  expect(future.summary.spend.amount).toBeNull(); expect(future.summary.profit).toBeNull();
 });
 it('includes unknown-source inquiries in the default overview without duplicating filtered unknown inquiries', () => {
  const row = { inquiries: 15, unattributed_inquiries: 7 };
  expect(calendarInquiryCount(row)).toBe(22);
  expect(calendarInquiryCount(row, '11')).toBe(15);
  expect(calendarInquiryCount({ inquiries: 7, unattributed_inquiries: 7 }, 'unknown')).toBe(7);
 });
});
describe('signed calendar colors', () => {
 it('always colors negative results red and positive results green, including refund-driven negative ROAS', () => {
  expect(calendarHeat(-100, 100).backgroundColor).toMatch(/^hsl\(0 /);
  expect(calendarHeat(100, 100).backgroundColor).toMatch(/^hsl\(140 /);
  const refunded = build({ groups: [{ ...group, finance: [{ currency: 'PHP', received_minor: 0, refunded_minor: 10000, records: 1 }] }] }).days[0];
  expect(refunded.gross_roas).toBe(-1);
  expect(calendarHeat(refunded.gross_roas, 5).backgroundColor).toMatch(/^hsl\(0 /);
 });
 it('keeps zero distinct from unknown values and uses equal intensity for equal gains and losses', () => {
  expect(calendarHeat(0, 100).backgroundColor).toBe('#ffffff');
  for (const value of [null, undefined, NaN, Infinity]) expect(calendarHeat(value, 100).backgroundColor).toBe('#f1f5f9');
  expect(calendarHeat(-50, 100).backgroundColor.split('%').slice(1)).toEqual(calendarHeat(50, 100).backgroundColor.split('%').slice(1));
 });
});
describe('exact Meta messaging and video metrics', () => {
 it('uses the matching conversation action without adding unrelated actions or inventing missing fields', () => {
  const value = dailyDeliveryMetrics({ actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }, { action_type: 'link_click', value: '20' }], video_play_actions: [{ action_type: 'video_view', value: '30' }] });
  expect(value.messaging_started).toBe(5); expect(value.video_plays).toBe(30); expect(value.video_complete).toBeNull(); expect(actionAmount(undefined, 'x')).toBeNull(); expect(actionAmount([], 'x')).toBe(0);
  expect(() => actionAmount([{ action_type: 'x', value: '-1' }], 'x')).toThrow(); expect(() => actionAmount([{ action_type: 'x', value: '1' }, { action_type: 'x', value: '2' }], 'x')).toThrow();
 });
});
