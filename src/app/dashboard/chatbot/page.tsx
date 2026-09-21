'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Bot, MessageSquare, Play, Power, PowerOff, Save, ShieldCheck } from 'lucide-react';

type PageSummary = {
    id: string;
    name: string;
};

type ChatbotConfig = {
    page_id: string;
    enabled: boolean;
    instructions: string;
    fallback_reply: string;
    model: string;
};

export default function ChatbotPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<PageSummary[]>([]);
    const [selectedPageId, setSelectedPageId] = useState('');
    const [config, setConfig] = useState<ChatbotConfig | null>(null);
    const [providerConfigured, setProviderConfigured] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [testMessage, setTestMessage] = useState('Hi! What services do you offer?');
    const [testReply, setTestReply] = useState('');

    useEffect(() => {
        if (!session) return;
        fetch('/api/pages')
            .then(async (response) => {
                const body = await response.json();
                if (!response.ok) throw new Error(body.message || body.error || 'Failed to load pages');
                return body;
            })
            .then((body) => {
                const nextPages = body.pages || [];
                setPages(nextPages);
                setSelectedPageId((current) => current || nextPages[0]?.id || '');
            })
            .catch((loadError) => setError(loadError.message));
    }, [session]);

    const loadConfig = useCallback(async () => {
        if (!selectedPageId) return;
        setLoading(true);
        setError('');
        setStatus('');
        setTestReply('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot');
            const body = await response.json();
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to load chatbot settings');
            setConfig(body.config);
            setProviderConfigured(Boolean(body.provider?.configured));
        } catch (loadError) {
            setError((loadError as Error).message);
        } finally {
            setLoading(false);
        }
    }, [selectedPageId]);

    useEffect(() => {
        loadConfig();
    }, [loadConfig]);

    const updateConfig = (changes: Partial<ChatbotConfig>) => {
        setConfig((current) => current ? { ...current, ...changes } : current);
        setStatus('');
    };

    const saveConfig = async () => {
        if (!config || !selectedPageId) return;
        setSaving(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to save chatbot settings');
            setConfig(body.config);
            setStatus('Chatbot settings saved.');
        } catch (saveError) {
            setError((saveError as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const testChatbot = async () => {
        if (!selectedPageId || !testMessage.trim()) return;
        setTesting(true);
        setError('');
        setTestReply('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: testMessage })
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.message || body.error || 'Chatbot test failed');
            setTestReply(body.reply);
        } catch (testError) {
            setError((testError as Error).message);
        } finally {
            setTesting(false);
        }
    };

    const selectedPageName = pages.find((page) => page.id === selectedPageId)?.name || 'this Page';

    return (
        <div className="max-w-4xl mx-auto">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 border-2 border-black bg-white flex items-center justify-center">
                        <Bot className="w-5 h-5" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-black">AI Chatbot</h1>
                        <p className="text-xs text-gray-500 font-mono">
                            DeepSeek replies to new Messenger messages through OpenRouter
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={saveConfig}
                    disabled={!config || saving}
                    className="btn-wireframe bg-black text-white hover:bg-gray-800 flex items-center justify-center gap-2 px-4 py-2.5 disabled:opacity-50"
                >
                    <Save className="w-4 h-4" />
                    {saving ? 'Saving...' : 'Save settings'}
                </button>
            </div>

            <div className="border-2 border-black p-4 mb-4 bg-white">
                <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Facebook Page</label>
                <select
                    value={selectedPageId}
                    onChange={(event) => setSelectedPageId(event.target.value)}
                    className="input-wireframe w-full text-sm"
                >
                    {pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
                </select>
            </div>

            {error && (
                <div className="border-2 border-red-600 bg-red-50 text-red-800 p-3 mb-4 text-sm">
                    {error}
                </div>
            )}
            {status && (
                <div className="border-2 border-green-700 bg-green-50 text-green-800 p-3 mb-4 text-sm">
                    {status}
                </div>
            )}

            {loading || !config ? (
                <div className="border-2 border-black p-8 text-center font-mono text-sm text-gray-500">
                    {selectedPageId ? 'Loading chatbot settings...' : 'Connect a Facebook Page to configure the chatbot.'}
                </div>
            ) : (
                <>
                    <div className="border-2 border-black p-4 mb-4 bg-white">
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                {config.enabled ? <Power className="w-5 h-5 text-green-700" /> : <PowerOff className="w-5 h-5 text-gray-400" />}
                                <div>
                                    <p className="font-bold text-sm">
                                        {config.enabled ? 'Chatbot active' : 'Chatbot disabled'}
                                    </p>
                                    <p className="text-xs text-gray-500 font-mono">
                                        {config.enabled
                                            ? 'Incoming text messages to ' + selectedPageName + ' receive an automatic reply.'
                                            : 'Turn this on after testing the instructions below.'}
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => updateConfig({ enabled: !config.enabled })}
                                disabled={!providerConfigured}
                                aria-label={config.enabled ? 'Disable chatbot' : 'Enable chatbot'}
                                className={'relative w-12 h-6 rounded-full transition-colors disabled:opacity-40 ' + (config.enabled ? 'bg-green-600' : 'bg-gray-300')}
                            >
                                <span className={'absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ' + (config.enabled ? 'translate-x-6' : 'translate-x-0.5')} />
                            </button>
                        </div>
                        <div className="mt-3 pt-3 border-t border-gray-300 flex items-center gap-2 text-xs font-mono">
                            <ShieldCheck className="w-4 h-4" />
                            OpenRouter: {providerConfigured ? 'configured' : 'missing OPENROUTER_API_KEY'}
                        </div>
                    </div>

                    <div className="border-2 border-black p-4 mb-4 bg-white">
                        <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">
                            Bot instructions
                        </label>
                        <textarea
                            value={config.instructions}
                            onChange={(event) => updateConfig({ instructions: event.target.value })}
                            rows={8}
                            maxLength={5000}
                            className="input-wireframe w-full text-sm resize-y"
                            placeholder="Explain your business, services, policies, tone, and when the bot should hand off to a person."
                        />
                        <p className="mt-2 text-xs text-gray-500 font-mono">
                            Include only facts the bot is allowed to use. It sees up to 20 recent messages for context.
                        </p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4 mb-4">
                        <div className="border-2 border-black p-4 bg-white">
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">
                                Fallback reply
                            </label>
                            <textarea
                                value={config.fallback_reply}
                                onChange={(event) => updateConfig({ fallback_reply: event.target.value })}
                                rows={4}
                                maxLength={1000}
                                className="input-wireframe w-full text-sm resize-y"
                            />
                            <p className="mt-2 text-xs text-gray-500">Sent if AI generation fails.</p>
                        </div>
                        <div className="border-2 border-black p-4 bg-white">
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">
                                OpenRouter model
                            </label>
                            <input
                                value={config.model}
                                onChange={(event) => updateConfig({ model: event.target.value })}
                                maxLength={200}
                                className="input-wireframe w-full text-sm"
                            />
                            <p className="mt-2 text-xs text-gray-500">
                                The default follows OpenRouter&apos;s latest DeepSeek Flash model.
                            </p>
                        </div>
                    </div>

                    <div className="border-2 border-black p-4 bg-[#f8f8f8]">
                        <div className="flex items-center gap-2 mb-3">
                            <MessageSquare className="w-4 h-4" />
                            <h2 className="font-bold text-sm">Test before enabling</h2>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input
                                value={testMessage}
                                onChange={(event) => setTestMessage(event.target.value)}
                                className="input-wireframe flex-1 text-sm"
                                placeholder="Enter a sample customer message"
                            />
                            <button
                                type="button"
                                onClick={testChatbot}
                                disabled={testing || !providerConfigured || !testMessage.trim()}
                                className="btn-wireframe bg-white flex items-center justify-center gap-2 px-4 disabled:opacity-50"
                            >
                                <Play className="w-4 h-4" />
                                {testing ? 'Generating...' : 'Test reply'}
                            </button>
                        </div>
                        {testReply && (
                            <div className="mt-3 border border-black bg-white p-3 text-sm">
                                <p className="font-mono text-[10px] uppercase text-gray-500 mb-1">Bot reply</p>
                                {testReply}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
