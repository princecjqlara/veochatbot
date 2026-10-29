'use client';
import { useEffect, useState } from 'react';
import { salesSettings, validateSalesSettings, type SalesSettings } from '@/lib/chatbot-sales-assistant';

export default function ChatbotSalesSettings({ value, onChange }: { value: unknown; onChange: (settings: SalesSettings) => void }) {
    const settings = salesSettings(value);
    const [advanced, setAdvanced] = useState(JSON.stringify(settings, null, 2));
    const [error, setError] = useState('');
    useEffect(() => { setAdvanced(JSON.stringify(salesSettings(value), null, 2)); }, [value]);
    return <div className="border-2 border-black p-5 mt-5 space-y-4">
        <h3 className="font-bold">Conversion sales assistant</h3>
        <p className="text-sm text-gray-600">The form is optional. Confirmed chat answers and form edits share the existing customer record. Existing human handoff rules remain in control.</p>
        <label className="flex items-center gap-3 font-medium"><input type="checkbox" checked={settings.pricing_enabled} onChange={e => onChange({ ...settings, pricing_enabled: e.target.checked })} />Pricing {settings.pricing_enabled ? 'ON' : 'OFF'}</label>
        <p className="text-xs text-gray-600">OFF acknowledges pricing questions without disclosing costs. ON uses approved pricing catalogs. Manage package inclusions, freebies and promotions in <a className="underline" href="/dashboard/pricing">Pricing Packages</a>.</p>
        <label className="block text-sm">Sales guidance <select className="border ml-3 p-2" value={settings.aggressiveness} onChange={e => onChange({ ...settings, aggressiveness: e.target.value as SalesSettings['aggressiveness'] })}>{['gentle', 'confident', 'direct'].map(choice => <option key={choice}>{choice}</option>)}</select></label>
        <label className="block text-sm">Maximum follow-ups per customer response <input className="border ml-3 p-2 w-20" type="number" min={0} max={30} value={settings.max_follow_ups} onChange={e => onChange({ ...settings, max_follow_ups: Number(e.target.value) })} /></label>
        <p className="text-xs text-gray-600">Use the existing follow-up controls below for timing and messaging windows.</p>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={settings.collection_enabled} onChange={e => onChange({ ...settings, collection_enabled: e.target.checked })} />Collect missing customer information through chat</label>
        <label className="block text-sm">Conversation introduction<textarea className="mt-2 w-full border p-3" maxLength={1000} rows={2} value={settings.introduction} onChange={e => onChange({ ...settings, introduction: e.target.value })} /></label>
        <label className="block text-sm">Sales process steps, one per line<textarea className="mt-2 w-full border p-3" rows={4} value={settings.process_steps.join('\n')} onChange={e => onChange({ ...settings, process_steps: e.target.value.split('\n').slice(0, 10) })} /></label>
        <details><summary className="cursor-pointer font-medium">Form questions and collection requirements</summary>
            {settings.fields.map((field, index) => <div key={index} className="border p-3 mt-3 space-y-2">
                <p className="text-sm font-medium">{field.label}</p>
                <label className="text-xs flex gap-2"><input type="checkbox" checked={field.enabled} onChange={e => onChange({ ...settings, fields: settings.fields.map((row, i) => i === index ? { ...row, enabled: e.target.checked } : row) })} />Show this field</label>
                <label className="text-xs flex gap-2"><input type="checkbox" checked={field.required} onChange={e => onChange({ ...settings, fields: settings.fields.map((row, i) => i === index ? { ...row, required: e.target.checked } : row) })} />Needed for a recommendation (customers can still skip)</label>
                <input aria-label={'Chat question for ' + field.label} className="border w-full p-2 text-sm" maxLength={200} value={field.question} onChange={e => onChange({ ...settings, fields: settings.fields.map((row, i) => i === index ? { ...row, question: e.target.value } : row) })} />
            </div>)}
        </details>
        <details><summary className="cursor-pointer font-medium">Introduction, steps, form fields, industry mappings and sample assignments</summary>
            <p className="text-xs text-gray-600 my-2">Edit the settings below, then apply and save the Page. Sample document IDs must refer to existing ready media in this Page’s approved library. Set active to false to exclude a sample. Required fields guide collection; they never block saving or purchasing.</p>
            <textarea aria-label="Sales assistant configuration" value={advanced} onChange={e => setAdvanced(e.target.value)} rows={20} className="w-full border p-3 font-mono text-xs" />
            {error && <p role="alert" className="text-red-700 text-sm">{error}</p>}
            <button type="button" className="border border-black px-4 py-2 mt-2" onClick={() => { try { onChange(validateSalesSettings(JSON.parse(advanced))); setError(''); } catch (err) { setError(err instanceof Error ? err.message : 'Invalid settings'); } }}>Apply sales settings</button>
        </details>
    </div>;
}
