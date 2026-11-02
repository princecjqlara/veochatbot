'use client';

import { useSession, signIn } from 'next-auth/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FacebookPage } from '@/types';
import { Check, Facebook, RefreshCw, AlertCircle } from 'lucide-react';
import { runContactSyncToCompletion } from '@/lib/contact-sync-client';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { getFacebookConnectErrorMessage, isFacebookReauthMessage } from '@/lib/facebook-errors';
import { DatabaseReadTimeout, requestDeadline } from '@/lib/request-deadline';

export default function ConnectPage() {
    const { data: session, status: sessionStatus } = useSession();
    const [facebookPages, setFacebookPages] = useState<FacebookPage[]>([]);
    const [loading, setLoading] = useState(true);
    const [connecting, setConnecting] = useState<string | null>(null);
    const [connectedPages, setConnectedPages] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [requiresReauth, setRequiresReauth] = useState(false);
    const [success, setSuccess] = useState<string | null>(null);
    const [connectionStatusError, setConnectionStatusError] = useState<string | null>(null);
    const [connectionStatusLoaded, setConnectionStatusLoaded] = useState(false);
    const [reconnectPages, setReconnectPages] = useState<Set<string>>(new Set());
    const [unverifiedPages, setUnverifiedPages] = useState<Set<string>>(new Set());
    const [syncingPages, setSyncingPages] = useState<Set<string>>(new Set());
    const [pageNotes, setPageNotes] = useState<Record<string, string>>({});
    const connectBusy = useRef(false), loadIssue = useRef(0), statusIssue = useRef(0), mounted = useRef(true);
    const userId = session?.user?.id;

    const fetchFacebookPages = useCallback(async () => {
        const issue = ++loadIssue.current;
        setLoading(true); setError(null);
        try {
            const { res, data } = await requestDeadline(async signal => {
                const res = await fetch('/api/facebook/pages', { cache: 'no-store', signal });
                return { res, data: await res.json() };
            }, 45000);
            if (!mounted.current || issue !== loadIssue.current) return;

            if (!res.ok || data.error || !Array.isArray(data.pages)) {
                const message = getFacebookConnectErrorMessage(data.message || data.error);
                setError(message);
                setRequiresReauth(Boolean(data.requiresReauth) || isFacebookReauthMessage(data.message || data.error || ''));
            } else {
                setFacebookPages(data.pages || []);
                setRequiresReauth(false);
            }
        } catch {
            if (!mounted.current || issue !== loadIssue.current) return;
            setError('Facebook Pages could not be loaded. Retry loading Pages or refresh permissions.');
            setRequiresReauth(false);
        } finally {
            if (mounted.current && issue === loadIssue.current) setLoading(false);
        }
    }, []);

    const fetchConnectedPages = useCallback(async () => {
        const issue = ++statusIssue.current;
        try {
            const { res, data } = await requestDeadline(async signal => {
                const res = await fetch('/api/pages?connectionDetails=1', { cache: 'no-store', signal });
                return { res, data: await res.json() };
            }, 15000);
            if (!res.ok || !Array.isArray(data.pages)) throw Error(data.error || 'Connection status unavailable');
            if (!mounted.current || issue !== statusIssue.current) return;
            const fbPageIds = new Set(data.pages?.map((p: { fb_page_id: string }) => p.fb_page_id) || []);
            setConnectedPages(fbPageIds as Set<string>);
            setUnverifiedPages(new Set(data.pages.filter((page: { connectionStatus?: string }) => page.connectionStatus === 'unknown').map((page: { fb_page_id: string }) => page.fb_page_id)));
            setReconnectPages(new Set((data.reconnectRequiredPages || []).map((page: { fb_page_id: string }) => page.fb_page_id)));
            setConnectionStatusLoaded(true); setConnectionStatusError(null);
        } catch {
            if (mounted.current && issue === statusIssue.current) setConnectionStatusError('Connection status is unavailable. Saved Page connections have not been marked disconnected.');
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        if (sessionStatus !== 'loading') {
            if (session?.user) { void fetchFacebookPages(); void fetchConnectedPages(); }
            else setLoading(false);
        }
        return () => { mounted.current = false; loadIssue.current++; statusIssue.current++; };
    // Session identity changes should reload; periodic session object updates should not reset active work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionStatus, userId, fetchFacebookPages, fetchConnectedPages]);

    useEffect(() => {
        if (!connectionStatusError) return;
        const retry = setInterval(() => { void fetchConnectedPages(); }, 30000);
        return () => clearInterval(retry);
    }, [connectionStatusError, fetchConnectedPages]);

    const syncContacts = async (page: FacebookPage, pageId: string) => {
        setSyncingPages(previous => new Set(previous).add(page.id));
        const note = (message: string) => { if (mounted.current) setPageNotes(previous => ({ ...previous, [page.id]: message })); };
        note('Connected. Initial contact sync is running.');
        try {
            const result = await runContactSyncToCompletion(pageId, { onProgress: ({ totalSynced }) => note(`Connected. Initial contact sync: ${totalSynced} contacts saved.`) });
            if (!result.completed) throw Error('Contact sync incomplete');
            note(`Connected. Synced ${result.totalSynced} contacts${result.totalFailed ? `; ${result.totalFailed} need retry` : ''}.`);
        } catch { note('Connected. Initial contact sync needs a retry from Contacts.'); }
        finally { if (mounted.current) setSyncingPages(previous => { const next = new Set(previous); next.delete(page.id); return next; }); }
    };

    const handleConnect = async (page: FacebookPage) => {
        if (connectBusy.current || syncingPages.has(page.id)) return;
        if (!page.access_token) { setError('Facebook did not return a Page token. Refresh Permissions and select this Page again.'); setRequiresReauth(true); return; }
        connectBusy.current = true;
        setConnecting(page.id);
        setError(null);
        setSuccess(null);

        try {
            const { res, data } = await requestDeadline(async signal => {
                const res = await fetch('/api/facebook/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal, body: JSON.stringify({
                    fbPageId: page.id,
                    name: page.name,
                    accessToken: page.access_token
                })
                });
                const text = await res.text(); let data;
                try { data = JSON.parse(text); } catch { throw Error('Connection did not return a valid response. Retry Connect to verify the saved state.'); }
                return { res, data };
            }, 75000);
            if (!mounted.current) return;
            if (data.success || data.saved) statusIssue.current++;

            if (res.ok && data.success && data.pageId && data.webhookSubscribed !== false) {
                setConnectedPages(prev => new Set([...prev, page.id]));
                setUnverifiedPages(previous => { const next = new Set(previous); next.delete(page.id); return next; });
                setReconnectPages(previous => { const next = new Set(previous); next.delete(page.id); return next; });
                setRequiresReauth(false);
                const connectedMessage = data.warning?.message || `Successfully connected "${page.name}".`;
                setSuccess(connectedMessage);
                void syncContacts(page, data.pageId);
            } else {
                if (data.saved) {
                    setReconnectPages(previous => new Set(previous).add(page.id));
                    setConnectedPages(previous => { const next = new Set(previous); next.delete(page.id); return next; });
                    setPageNotes(previous => ({ ...previous, [page.id]: 'Page access saved. Reconnect is required to finish live updates.' }));
                }
                setError(getFacebookConnectErrorMessage(data.message || data.error));
                setRequiresReauth(Boolean(data.requiresReauth) || isFacebookReauthMessage(data.message || data.error || ''));
            }
        } catch (error) {
            if (mounted.current) setError(error instanceof DatabaseReadTimeout ? 'The connection request timed out. Retry Connect to verify whether the Page was saved.' : (error as Error).message || 'Failed to connect page');
        } finally {
            connectBusy.current = false;
            if (mounted.current) setConnecting(null);
        }
    };

    const handleFacebookLogin = async () => {
        setLoading(true);
        setError(null);
        setRequiresReauth(false);
        try { await requestDeadline(() => signIn(
            'facebook',
            { callbackUrl: '/dashboard/connect' },
            {
                auth_type: 'rerequest',
                scope: FACEBOOK_PERMISSION_SCOPE
            }
        ), 15000); }
        catch { setError('Facebook sign-in could not be started. Please retry Refresh Permissions.'); }
        finally { if (mounted.current) setLoading(false); }
    };

    // Show connected pages from database
    if (sessionStatus === 'loading') return <div role="status" className="p-8">Loading your Facebook session...</div>;
    if (!session?.user) {
        return (
            <div className="max-w-[600px] mx-auto p-8 mt-12">
                <div className="wireframe-card text-center py-12">
                    <Facebook className="w-16 h-16 mx-auto mb-6 text-blue-600" />
                    <h1 className="text-2xl font-black uppercase mb-2">
                        Connect Facebook
                    </h1>
                    <p className="font-mono text-sm text-gray-500 mb-8 max-w-sm mx-auto">
                        Please sign in to view connected pages.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 md:p-8 max-w-[1000px] mx-auto fade-in">
            {/* Header */}
            <div className="mb-8 border-b-2 border-black pb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-black uppercase mb-1">
                        Connect Pages
                    </h1>
                    <p className="font-mono text-sm text-gray-500 uppercase tracking-wide">
                        Select Facebook pages to manage
                    </p>
                </div>

                <button
                    onClick={handleFacebookLogin}
                    className="btn-wireframe text-xs bg-white h-9"
                >
                    <RefreshCw className="w-3 h-3 mr-2" />
                    Refresh Permissions
                </button>
                <button onClick={() => { void fetchFacebookPages(); void fetchConnectedPages(); }} disabled={loading || connecting !== null} className="btn-wireframe text-xs bg-white h-9">Retry loading Pages</button>
            </div>

            {/* Messages */}
            {connectionStatusError && <p role="alert" className="mb-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm">{connectionStatusError}</p>}
            {error && (
                <div className="mb-6 p-4 border border-black bg-red-50 flex flex-col md:flex-row md:items-center gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <span className="text-sm font-bold text-red-800 uppercase flex-1">{error}</span>
                    {requiresReauth && (
                        <button
                            onClick={handleFacebookLogin}
                            className="btn-wireframe text-xs bg-white h-9 shrink-0"
                        >
                            <RefreshCw className="w-3 h-3 mr-2" />
                            Refresh Permissions
                        </button>
                    )}
                </div>
            )}

            {success && (
                <div className="mb-6 p-4 border border-black bg-green-50 flex items-start gap-3">
                    <Check className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                    <span className="text-sm font-bold text-green-800 uppercase">{success}</span>
                </div>
            )}

            {/* Content */}
            {loading ? (
                <div className="flex justify-center py-20 wireframe-card">
                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
                </div>
            ) : facebookPages.length === 0 ? (
                <div className="wireframe-card text-center py-12">
                    <p className="text-lg font-bold uppercase mb-2">No Facebook Pages found</p>
                    <p className="font-mono text-sm text-gray-500 mb-4">
                        Ensure you are an admin of a Facebook Page and have granted permissions.
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto border border-black">
                    <table className="table-wireframe">
                        <thead>
                            <tr>
                                <th>Page Name</th>
                                <th>Category</th>
                                <th>Status</th>
                                <th className="text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white">
                            {facebookPages.map((page) => {
                                const unverified = unverifiedPages.has(page.id), isConnected = connectedPages.has(page.id) && !unverified, needsReconnect = reconnectPages.has(page.id), syncing = syncingPages.has(page.id);
                                const isConnecting = connecting === page.id;

                                return (
                                    <tr key={page.id} className="hover:bg-gray-50 transition-colors">
                                        <td className="font-bold">{page.name}{pageNotes[page.id] && <p role="status" className="mt-1 text-xs font-normal normal-case">{pageNotes[page.id]}</p>}</td>
                                        <td className="font-mono text-xs text-gray-500 uppercase">{page.category || '-'}</td>
                                        <td>
                                            {isConnected ? (
                                                <span className="badge-wireframe bg-black text-white border-black">
                                                    Connected
                                                </span>
                                            ) : (
                                                <span className="badge-wireframe bg-gray-100 text-gray-400 border-gray-200">
                                                    {needsReconnect ? 'Setup incomplete' : connectionStatusError || unverified ? 'Status unavailable' : connectionStatusLoaded ? 'Not Connected' : 'Checking status...'}
                                                </span>
                                            )}
                                        </td>
                                        <td className="text-right">
                                            {isConnected ? (
                                                <button
                                                    onClick={() => handleConnect(page)}
                                                    disabled={connecting !== null || syncing}
                                                    className="btn-wireframe text-xs py-1.5 h-8 bg-white text-black hover:bg-gray-100"
                                                >
                                                    {isConnecting ? (
                                                        <span className="animate-pulse">Reconnecting...</span>
                                                    ) : (
                                                        syncing ? 'Syncing contacts...' : 'Reconnect'
                                                    )}
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => handleConnect(page)}
                                                    disabled={connecting !== null || syncing}
                                                    className="btn-wireframe text-xs py-1.5 h-8 bg-black text-white hover:bg-gray-800"
                                                >
                                                    {isConnecting ? (
                                                        <span className="animate-pulse">Connecting...</span>
                                                    ) : (
                                                        needsReconnect || unverified ? 'Reconnect' : 'Connect'
                                                    )}
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
