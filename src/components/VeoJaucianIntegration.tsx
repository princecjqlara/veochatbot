'use client';
import { useEffect, useState } from 'react';

const field = 'border border-slate-300 rounded px-3 py-2 bg-white text-slate-900 w-full';
const button = 'rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40';
type Props = { submit: (body: any) => Promise<any>; busy: boolean; editable?: boolean };

export default function VeoJaucianIntegration({ submit, busy, editable = true }: Props) {
    const [data, setData] = useState<any>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
    const [teamId, setTeamId] = useState(''), [destination, setDestination] = useState(''), [topic, setTopic] = useState('');
    const [workerId, setWorkerId] = useState(''), [telegramId, setTelegramId] = useState('');
    const [staffChat, setStaffChat] = useState('');
    async function refresh(signal?: AbortSignal) {
        setLoading(true); setError('');
        try {
            const response = await fetch('/api/workspace/jaucian', { cache: 'no-store', signal });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Jaucian connection unavailable');
            if (!signal?.aborted) setData(body);
        } catch (e: any) { if (e.name !== 'AbortError') setError(e.message); }
        finally { if (!signal?.aborted) setLoading(false); }
    }
    useEffect(() => { const controller = new AbortController(); refresh(controller.signal); return () => controller.abort(); }, []);
    const workspace = data?.workspace, jaucian = data?.jaucian;
    const groups = jaucian?.groups || [], teams = workspace?.teams || [], accounts = workspace?.accounts || [];
    const workers = accounts.filter((a: any) => ['manager', 'member', 'team_leader'].includes(a.role));
    const worker = workers.find((w: any) => w.user_id === workerId);
    const workerTeam = worker && teams.find((t: any) => t.manager_id === (['manager', 'team_leader'].includes(worker.role) ? worker.user_id : worker.parent_id));
    const workerGroup = groups.find((g: any) => String(g.chat_id) === String(worker?.role === 'team_leader' ? staffChat || worker.telegram_chat_id : workerTeam?.telegram_chat_id));
    const teamGroups = (t: any) => t.telegram_groups_managed ? t.telegram_groups || [] : [{ chat_id: t.telegram_chat_id }];
    const unmappedTeams = teams.filter((t: any) => !teamGroups(t).some((l: any) => groups.some((g: any) => String(g.chat_id) === String(l.chat_id))));
    return <section className="rounded border bg-white p-5 space-y-4" aria-label="Jaucian integration">
        <div className="flex items-center justify-between gap-3"><h2 className="font-bold text-xl">Jaucian connection and Telegram setup</h2><button type="button" disabled={loading || busy} className="underline disabled:opacity-40" onClick={() => refresh()}>Refresh connection</button></div>
        {loading && <p role="status">Checking both services…</p>}
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {data && <>
            <p className="text-xs text-slate-500">Last successful directory check: {new Date(jaucian.checked_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT</p>
            <p className="font-semibold">VEO can read Jaucian’s database directory. {jaucian.veo_connection?.ok ? 'Jaucian can read VEO’s team directory and verified reports.' : 'The connection from Jaucian to VEO needs attention.'}</p>
            {jaucian.veo_connection?.error && <p role="alert" className="text-red-700">{jaucian.veo_connection.error}</p>}
            <p className="text-sm">{groups.length} approved VEO groups · {unmappedTeams.length} teams without an active destination · {workers.filter((w: any) => !w.telegram_user_id).length} workers without a Telegram identity</p>
            {workspace.account_coverage?.disabled_login_accounts > 0 && <p className="rounded border bg-amber-50 p-3 text-sm">{workspace.account_coverage.disabled_login_accounts} retained accounts have disabled logins and are excluded from the bot directory. Review staff access before linking their Telegram accounts.</p>}
            {workspace.telegram_sync && <p className="text-sm">Automatic Telegram sync: {!workspace.telegram_sync.configured ? 'Setup required; scheduling is unavailable.' : workspace.telegram_sync.last_sync_at ? `Last completed ${new Date(workspace.telegram_sync.last_sync_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT.` : 'Scheduled; waiting for the first completed scan.'} {workspace.telegram_sync.last_error || workspace.telegram_sync.auto_last_error || ''}</p>}
            <p className="text-sm text-slate-600">The existing Jaucian bot handles delivery. Verified payments, personal quotas and commission calculations come from VEO. Telegram receipts cannot create another sale. Identity suggestions include observed history and may omit members; saving checks current human membership.</p>
            {editable && <div className="grid gap-5 lg:grid-cols-2">
                <form className="space-y-3 border rounded p-4" onSubmit={async e => {
                    e.preventDefault();
                    const saved = await submit({ action: 'mapping', team_id: teamId, chat_id: destination, thread_id: topic || null });
                    if (saved) await refresh();
                }}><h3 className="font-bold">Team destination</h3>
                    <label className="block">Team Leader or Manager<select required className={field} value={teamId} onChange={e => {
                        setTeamId(e.target.value); const t = teams.find((t: any) => t.id === e.target.value);
                        setDestination(t?.telegram_chat_id ? String(t.telegram_chat_id) : ''); setTopic(t?.telegram_thread_id ? String(t.telegram_thread_id) : '');
                    }}><option value="">Choose a Team Leader or Manager</option>{teams.map((t: any) => { const supervisor = accounts.find((a: any) => a.user_id === t.manager_id);return <option key={t.id} value={t.id}>{t.name} - {supervisor?.role === 'team_leader' ? 'Team Leader (no manager needed)' : 'Manager'}</option>; })}</select></label>
                    <label className="block">Existing Jaucian group<select required className={field} value={destination} onChange={e => { setDestination(e.target.value); setTopic(''); }}><option value="">Choose approved group</option>{groups.map((g: any) => <option key={g.chat_id} value={String(g.chat_id)}>{g.name} ({g.chat_id})</option>)}</select></label>
                    <label className="block">Topic override (optional)<input type="number" min="1" step="1" className={field} value={topic} onChange={e => setTopic(e.target.value)} /></label>
                    <p className="text-xs text-slate-600">Leave blank to use Jaucian’s existing Closed Deal, Done Deal and announcement topics. An override sends all this team’s posts to that topic.</p>
                    {destination && <p className="text-xs text-slate-600">Known topics: {Object.entries(groups.find((g: any) => String(g.chat_id) === destination)?.topics || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Unavailable'}. Leave blank to use the group’s main chat.</p>}
                    <button className={button} disabled={busy || loading || !teamId || !destination || !!error}>Save team destination</button>
                </form>
                <form className="space-y-3 border rounded p-4" onSubmit={async e => {
                    e.preventDefault(); const saved = await submit({ action: 'mapping', user_id: workerId, telegram_user_id: telegramId, chat_id: String(workerGroup?.chat_id || '') });
                    if (saved) await refresh();
                }}><h3 className="font-bold">Worker Telegram identity</h3>
                    <label className="block">Worker / Team Leader<select required className={field} value={workerId} onChange={e => { setWorkerId(e.target.value); const person = workers.find((w: any) => w.user_id === e.target.value); setTelegramId(String(person?.telegram_user_id || '')); setStaffChat(String(person?.telegram_chat_id || '')); }}><option value="">Choose worker</option>{workers.map((w: any) => <option key={w.user_id} value={w.user_id}>{w.name} ({w.role})</option>)}</select></label>
                    {worker?.role === 'team_leader' && <label className="block">Leader’s primary team group<select required className={field} value={staffChat} onChange={e => { setStaffChat(e.target.value); setTelegramId(''); }}><option value="">Choose a mapped group in this leader’s branch</option>{groups.filter((g: any) => teams.some((t: any) => t.leader_id === worker.user_id && String(t.telegram_chat_id) === String(g.chat_id))).map((g: any) => <option key={g.chat_id} value={String(g.chat_id)}>{g.name}</option>)}</select></label>}
                    {worker && <p className="text-sm">Declared username: {worker.telegram_username ? `@${worker.telegram_username}` : 'Unavailable'} · Group: {workerGroup?.name || 'Map the team destination first'}. Select the person’s matching identity; a typed username alone does not verify identity.</p>}
                    <label className="block">Observed Telegram identity<select className={field} value={workerGroup?.identities.some((i: any) => String(i.user_id) === telegramId) ? telegramId : ''} onChange={e => setTelegramId(e.target.value)}><option value="">Choose identity or enter an ID below</option>{(workerGroup?.identities || []).map((i: any) => <option key={i.user_id} value={String(i.user_id)}>{i.name} ({i.user_id})</option>)}</select></label>
                    <label className="block">Human Telegram user ID<input required className={field} inputMode="numeric" pattern="[1-9][0-9]*" value={telegramId} onChange={e => setTelegramId(e.target.value)} /></label>
                    <button className={button} disabled={busy || loading || !worker || !workerGroup || !telegramId || !!error}>Verify and save worker identity</button>
                </form>
            </div>}
            <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="text-left font-semibold mb-2">Current team mappings</caption><thead><tr>{['VEO team', 'Jaucian group', 'Worker identities'].map(t => <th key={t} className="border-b p-2">{t}</th>)}</tr></thead><tbody>{teams.map((t: any) => {
                const roster = workers.filter((w: any) => w.user_id === t.manager_id || w.role === 'member' && w.parent_id === t.manager_id);
                return <tr key={t.id}><td className="border-b p-2">{t.name}</td><td className="border-b p-2">{teamGroups(t).map((l: any) => groups.find((g: any) => String(g.chat_id) === String(l.chat_id))?.name).filter(Boolean).join(', ') || 'Destination required'}</td><td className="border-b p-2">{roster.filter((w: any) => w.telegram_user_id).length} / {roster.length} mapped</td></tr>;
            })}</tbody></table></div>
            <div><h3 className="font-bold">Recent Jaucian deliveries</h3>{!(jaucian.recent_deliveries || []).length ? <p className="text-sm">No workspace deliveries recorded yet. Eligible Closed or Done receipts, mapped teams and verified worker identities are required.</p> : <ul className="text-sm space-y-2">{jaucian.recent_deliveries.map((d: any) => <li key={d.id}>{groups.find((g: any) => String(g.chat_id) === String(d.chat_id))?.name || 'Unknown group'} · {d.veo_intake_notice_id ? 'Fresh client inquiry' : d.veo_intake_offer_id ? 'Client assignment offer' : d.veo_intake_request_id ? 'Client assignment controls' : d.veo_intake_help ? 'Assignment setup help' : d.veo_report_date ? `Report ${d.veo_report_date}` : d.veo_availability_date ? `Active-tomorrow poll ${d.veo_availability_date}` : d.veo_receipt_kind === 'closed' ? 'Closed Deal confirmation' : 'Done Deal confirmation'} · {d.status} · attempts {d.attempts}{d.review_required && <strong className="text-red-700"> · Reconciliation required; automatic resend held</strong>}</li>)}</ul>}</div>
        </>}
    </section>;
}
