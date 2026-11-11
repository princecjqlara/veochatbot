import Link from 'next/link';
export default function VeoSupervisorGroups({ data, onAdd }: { data: any; onAdd: (team: string) => void }) {
    const supervisors = (data.accounts || []).filter((a: any) => ['team_leader', 'manager'].includes(a.role));
    return <section className="space-y-3" aria-label="Supervisor group and Page assignments">
        <h3 className="font-bold">Team Leader and Manager assignments</h3>
        <p className="text-sm text-slate-600">Keep multiple groups for each supervisor and select multiple Pages in each group. Adding another group keeps existing links. Each team/Page uses one delivery destination; moving a Page requires the Move Pages option.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{['Supervisor', 'Assigned Pages', 'Managed Telegram groups', ''].map((label, i) => <th key={i} className="p-2 border-b">{label}</th>)}</tr></thead><tbody>{supervisors.map((account: any) => {
            const team = (data.teams || []).find((t: any) => t.manager_id === account.user_id);
            const pageIds = [...new Set<string>(account.page_ids || [])];
            const links = (data.links || []).filter((l: any) => l.team_id === team?.id);
            return <tr key={account.user_id}><td className="p-2 border-b"><strong>{account.name}</strong><span className="block text-xs text-slate-500">{account.role.replaceAll('_', ' ')}</span></td>
                <td className="p-2 border-b">{pageIds.length} Pages<p className="text-xs text-slate-500">{pageIds.map(id => data.pages.find((p: any) => p.id === id)?.name || 'Page details unavailable').join(', ') || 'Ask the supervisor to assign Page access first.'}</p></td>
                <td className="p-2 border-b">{links.length} groups{links.map((l: any) => <p className="mt-1 text-xs text-slate-500" key={String(l.chat_id)}>{data.groups.find((g: any) => String(g.chat_id) === String(l.chat_id))?.name || 'Group unavailable'} · {(data.routes || []).filter((r: any) => r.team_id === team.id && String(r.chat_id) === String(l.chat_id)).length} Pages</p>)}</td>
                <td className="p-2 border-b">{team && data.can_manage ? <button type="button" aria-label={'Add another group for ' + account.name} className="text-sm underline" onClick={() => onAdd(team.id)}>Add another group</button> : !team ? 'Team setup needs attention' : null}</td></tr>;
        })}</tbody></table></div>
        <Link className="text-sm underline" href="/dashboard/workspace?view=accounts">Manage account Page assignments</Link>
    </section>;
}
