'use client';
import Link from 'next/link';
export type WorkspaceContact = { id: string; page_id: string; name: string | null; page_name: string; psid: string | null; pipeline_stage: string | null };
export default function VeoWorkspaceContacts({ items, total, offset, loading, onOffset, onSelect }: {
    items: WorkspaceContact[]; total: number; offset: number; loading: boolean;
    onOffset: (offset: number) => void; onSelect: (contact: WorkspaceContact) => void;
}) {
    return <section className="rounded border bg-white p-5" aria-busy={loading}>
        <h2 className="font-bold text-xl">Contacts</h2>
        <p className="text-sm text-slate-600 my-2">Search names, client IDs or saved contact details. Contacts are shared on your assigned pages; a client does not need an order to appear here.</p>
        {loading ? <p role="status" className="py-5">Searching contacts…</p> : <>
            <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{['Client', 'Page', 'Stage', 'Action'].map(t => <th key={t} className="border-b p-3">{t}</th>)}</tr></thead><tbody>{items.map(c => <tr key={c.id}>
                <td className="border-b p-3"><Link className="underline font-semibold" href={`/dashboard/contacts/${c.id}?pageId=${c.page_id}`}>{c.name || 'Unknown client'}</Link><p className="text-xs text-slate-500">Client ID: {c.psid || 'Unavailable'}</p></td>
                <td className="border-b p-3">{c.page_name}</td><td className="border-b p-3">{(c.pipeline_stage || 'Unknown').replaceAll('_', ' ')}</td>
                <td className="border-b p-3"><a href="#create-order" className="underline" onClick={() => onSelect(c)}>Use client</a></td>
            </tr>)}</tbody></table></div>
            {!items.length && <p className="py-5 text-slate-500">No contacts match this search on your assigned pages.</p>}
            <div className="flex items-center justify-between gap-3 mt-3 text-sm"><button className="underline disabled:opacity-40" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - 25))}>Previous contacts</button><p>{total} contacts · {offset + (items.length ? 1 : 0)}–{offset + items.length}</p><button className="underline disabled:opacity-40" disabled={offset + 25 >= total} onClick={() => onOffset(offset + 25)}>Next contacts</button></div>
        </>}
    </section>;
}
