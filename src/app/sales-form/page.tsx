'use client';
import { useEffect, useRef, useState } from 'react';
import type { SalesField } from '@/lib/chatbot-sales-assistant';

export default function SalesFormPage() {
    const [fields, setFields] = useState<SalesField[]>([]);
    const [details, setDetails] = useState<Record<string, string>>({});
    const [base, setBase] = useState<Record<string, string>>({});
    const [message, setMessage] = useState('Loading your saved answers…');
    const [busy, setBusy] = useState(false);
    const [conflicts, setConflicts] = useState<string[]>([]);
    const [suggestions, setSuggestions] = useState<Record<string, string>>({});
    const token = useRef(''); const event = useRef('');
    useEffect(() => {
        token.current = new URLSearchParams(window.location.search).get('token') || '';
        const load = async () => {
            try {
                const response = await fetch('/api/sales-form?token=' + encodeURIComponent(token.current), { cache: 'no-store', referrerPolicy: 'no-referrer' });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error);
                setFields(data.fields); setDetails(data.details); setBase(data.details); setSuggestions(data.suggestions || {}); setMessage('Optional po ang form. Sagutan ang alam mo, o magpatuloy lang sa chat.');
            } catch (error) { setMessage(error instanceof Error ? error.message : 'Please continue in chat.'); }
        };
        void load();
    }, []);
    return <main className="min-h-screen bg-gray-50 px-5 py-10" style={{ maxWidth: 720, margin: 'auto' }}>
        <meta name="referrer" content="no-referrer" />
        <h1 className="text-2xl font-bold mb-3">Your commercial video details</h1>
        <p role="status" className="mb-6 text-gray-700">{message}</p>
        {Object.entries(suggestions).map(([label, value]) => <p key={label} className="mb-3 text-sm text-gray-600">Suggested {label}: {value}. Please confirm this in chat if it fits your business.</p>)}
        {!!fields.length && <form onSubmit={async eventObject => {
            eventObject.preventDefault(); setBusy(true);
            event.current ||= crypto.randomUUID();
            try {
                const response = await fetch('/api/sales-form?token=' + encodeURIComponent(token.current), { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ details, base, event_key: event.current }), referrerPolicy: 'no-referrer' });
                const data = await response.json();
                if (data.details) { setDetails(data.details); setBase(data.details); setConflicts(data.conflicts || []); event.current = ''; }
                if (!response.ok && response.status !== 409) throw new Error(data.error);
                setMessage(data.message);
            } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save. Please try again.'); }
            finally { setBusy(false); }
        }}>
            {fields.map(field => <label key={field.label} className="block mb-5 font-medium">{field.label} <span className="font-normal text-gray-500">{field.required ? '(helpful for your recommendation)' : '(optional)'}</span>
                <textarea value={details[field.label] || ''} maxLength={500} rows={2} className="block mt-2 w-full rounded border border-gray-400 bg-white p-3 font-normal" onChange={e => { setDetails({ ...details, [field.label]: e.target.value }); event.current = ''; }} />
                {conflicts.includes(field.label) && <span className="text-amber-800 text-sm">This answer changed while the form was open. Review the current value above.</span>}
            </label>)}
            <button disabled={busy} className="bg-black text-white rounded px-6 py-3 disabled:opacity-50">{busy ? 'Saving…' : 'Save and continue in chat'}</button>
            <p className="text-sm text-gray-500 mt-4">You can save partial answers and reopen this link. Corrections also work in chat.</p>
        </form>}
    </main>;
}
