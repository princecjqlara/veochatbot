'use client';
import { useState } from 'react';
export default function VeoDeferredSection({ title, children }: { title: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return <section className="rounded-xl border border-slate-200 bg-white"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left font-semibold"><span>{title}</span><span className="text-sm font-normal text-slate-500">{open ? 'Hide' : 'View'}</span></button>{open && <div className="border-t border-slate-100 p-4">{children}</div>}</section>;
}
