'use client';
export default function VeoMemberSupervisors({ accounts, scope, busy, submit }: { accounts: any[]; scope: any; busy: boolean; submit: (body: any) => Promise<any> }) {
    if (!['owner', 'team_leader'].includes(scope.role)) return null;
    const members = accounts.filter(a => a.active !== false && a.role === 'member');
    const supervisors = accounts.filter(a => a.active !== false && ['team_leader', 'manager'].includes(a.role));
    if (!members.length) return null;
    return <section aria-label="Existing member supervisors" className="rounded-xl border bg-white p-5 space-y-3">
        <h2 className="font-bold text-xl">Member supervisors</h2>
        <p className="text-sm text-slate-600">Choose a Team Leader for direct reporting without a Manager. This uses the existing account and keeps its email, password and Page assignments. The supervisor must already have access to those Pages. Earlier orders keep their recorded teams.</p>
        {members.map(member => <form key={member.id + ':' + member.parent_id} className="flex flex-wrap items-end gap-3 rounded-lg border p-3" onSubmit={async event => {
            event.preventDefault();const values = new FormData(event.currentTarget);
            await submit({ action: 'member_supervisor', user_id: member.id, parent_id: values.get('parent_id'), expected_parent_id: member.parent_id });
        }}><label className="min-w-60 flex-1 text-sm"><strong>{member.name}</strong><span className="mt-1 block text-xs text-slate-500">Current: {accounts.find(a => a.id === member.parent_id)?.name || 'Supervisor unavailable'}</span>
                <select aria-label={'Supervisor for ' + member.name} name="parent_id" required defaultValue={member.parent_id} className="mt-2 block w-full rounded border p-2">{supervisors.map(parent => <option key={parent.id} value={parent.id}>{parent.name} · {parent.role === 'team_leader' ? 'Team Leader — direct member' : 'Manager'}</option>)}</select>
            </label><button disabled={busy} className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40">Save supervisor</button></form>)}
    </section>;
}
