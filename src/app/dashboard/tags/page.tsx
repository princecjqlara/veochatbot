'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Edit2, Check, X, Tag as TagIcon, Search } from 'lucide-react';
import Pagination from '@/components/Pagination';
import Modal from '@/components/Modal';
import { Tag, Page, PaginatedResponse } from '@/types';

interface TeamMember {
    id: string;
    name: string | null;
    email: string | null;
}

const TAG_COLORS = [
    '#000000', '#4b5563', '#dc2626', '#ea580c', '#d97706',
    '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777'
];

export default function TagsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [loading, setLoading] = useState(true);
    const [tagKind, setTagKind] = useState('manual');
    const [tagSearch, setTagSearch] = useState('');
    const [kindCounts, setKindCounts] = useState<Record<string, number>>({});
    const tagRequest = useRef(0);

    // Pagination
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const [total, setTotal] = useState(0);

    // Selection
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // Modals
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);

    // Form state
    const [editingTag, setEditingTag] = useState<Tag | null>(null);
    const [tagName, setTagName] = useState('');
    const [tagColor, setTagColor] = useState(TAG_COLORS[0]);
    const [tagOwnerType, setTagOwnerType] = useState<'user' | 'page'>('page');
    const [tagIsShared, setTagIsShared] = useState(false);
    const [selectedShareUserIds, setSelectedShareUserIds] = useState<Set<string>>(new Set());
    const [actionLoading, setActionLoading] = useState(false);

    // Team members for selected page
    const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
    const [teamLoading, setTeamLoading] = useState(false);

    useEffect(() => {
        fetchPages();
    }, []);

    useEffect(() => {
        if (selectedPageId || session?.user?.id) {
            fetchTags();
        }
    }, [selectedPageId, page, pageSize, session, tagKind, tagSearch]);

    useEffect(() => {
        if (selectedPageId) {
            fetchTeamMembers(selectedPageId);
            return;
        }

        setTeamMembers([]);
    }, [selectedPageId]);

    const fetchPages = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            setPages(data.pages || []);
            if (data.pages?.length > 0) {
                setSelectedPageId(data.pages[0].id);
            }
        } catch (error) {
            console.error('Error fetching pages:', error);
        }
    };

    const fetchTags = async () => {
        const requestNumber = ++tagRequest.current;
        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: page.toString(),
                pageSize: pageSize.toString(),
                scope: 'all',
                kind: tagKind,
                search: tagSearch,
                ...(selectedPageId && { pageId: selectedPageId })
            });

            const res = await fetch(`/api/tags?${params}`);
            const data: PaginatedResponse<Tag> & { kind_counts?: Record<string, number> } = await res.json();
            if (!res.ok) throw new Error('Could not load tags');
            if (requestNumber !== tagRequest.current) return;

            setTags(data.items || []);
            setTotal(data.total || 0);
            setKindCounts(data.kind_counts || {});
        } catch (error) {
            console.error('Error fetching tags:', error);
        } finally {
            if (requestNumber === tagRequest.current) setLoading(false);
        }
    };

    const handleSelectAll = () => {
        const deletableTags = tags.filter((tag) => !tag.is_default && !tag.system_key);
        if (deletableTags.length > 0 && deletableTags.every((tag) => selectedIds.has(tag.id))) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(deletableTags.map((tag) => tag.id)));
        }
    };

    const handleSelect = (id: string) => {
        if (tags.some((tag) => tag.id === id && (tag.is_default || tag.system_key))) return;
        const newSelected = new Set(selectedIds);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedIds(newSelected);
    };

    const handleCreate = async () => {
        if (!tagName.trim()) return;

        setActionLoading(true);
        try {
            const ownerId = tagOwnerType === 'page' ? selectedPageId : session?.user?.id;

            const response = await fetch('/api/tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: tagName.trim(),
                    color: tagColor,
                    ownerType: tagOwnerType,
                    ownerId,
                    pageId: selectedPageId,
                    isShared: tagOwnerType === 'user' ? tagIsShared : false,
                    sharedWithUserIds: tagOwnerType === 'user' && tagIsShared
                        ? Array.from(selectedShareUserIds)
                        : []
                })
            });

            if (!response.ok) throw new Error('Could not create tag');
            setShowCreateModal(false);
            setTagName('');
            setTagColor(TAG_COLORS[0]);
            setTagIsShared(false);
            setSelectedShareUserIds(new Set());
            if (tagKind === 'manual' && page === 1) await fetchTags();
            else { setTagKind('manual'); setPage(1); }
        } catch (error) {
            console.error('Error creating tag:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleEdit = async () => {
        if (!editingTag || !tagName.trim()) return;

        setActionLoading(true);
        try {
            const payload: {
                id: string;
                name: string;
                color: string;
                isShared?: boolean;
                sharedWithUserIds?: string[];
            } = {
                id: editingTag.id,
                name: tagName.trim(),
                color: tagColor
            };

            if (editingTag.owner_type === 'user') {
                payload.isShared = tagIsShared;
                payload.sharedWithUserIds = tagIsShared ? Array.from(selectedShareUserIds) : [];
            }

            await fetch('/api/tags', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            setShowEditModal(false);
            setEditingTag(null);
            setTagName('');
            setTagIsShared(false);
            setSelectedShareUserIds(new Set());
            await fetchTags();
        } catch (error) {
            console.error('Error updating tag:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!editingTag) return;

        setActionLoading(true);
        try {
            await fetch(`/api/tags?id=${editingTag.id}`, {
                method: 'DELETE'
            });

            setShowDeleteModal(false);
            setEditingTag(null);
            await fetchTags();
        } catch (error) {
            console.error('Error deleting tag:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;

        setActionLoading(true);
        try {
            await fetch('/api/tags/bulk', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tagIds: Array.from(selectedIds)
                })
            });

            setShowBulkDeleteModal(false);
            setSelectedIds(new Set());
            await fetchTags();
        } catch (error) {
            console.error('Error bulk deleting tags:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const openEditModal = (tag: Tag) => {
        setEditingTag(tag);
        setTagName(tag.name);
        setTagColor(tag.color);
        setTagIsShared(Boolean(tag.is_shared));
        setSelectedShareUserIds(new Set(tag.shared_with_user_ids || []));
        setShowEditModal(true);
    };

    const fetchTeamMembers = async (pageId: string) => {
        setTeamLoading(true);
        try {
            const res = await fetch(`/api/pages/${pageId}/team`);
            const data = await res.json();

            setTeamMembers(data.members || []);
        } catch (error) {
            console.error('Error fetching team members:', error);
            setTeamMembers([]);
        } finally {
            setTeamLoading(false);
        }
    };

    const toggleShareMember = (userId: string) => {
        setSelectedShareUserIds((previous) => {
            const next = new Set(previous);
            if (next.has(userId)) {
                next.delete(userId);
            } else {
                next.add(userId);
            }

            return next;
        });
    };

    const getTeamMemberDisplayName = (member: TeamMember) => {
        return member.name || member.email || member.id;
    };

    const selectableTeamMembers = teamMembers
        .filter((member) => member.id !== session?.user?.id);

    const openDeleteModal = (tag: Tag) => {
        setEditingTag(tag);
        setShowDeleteModal(true);
    };

    const getOwnerTypeLabel = (tag: Tag) => {
        switch (tag.owner_type) {
            case 'user': return 'Personal';
            case 'page': return 'Page';
            case 'business': return 'Business';
            default: return tag.owner_type;
        }
    };

    return (
        <div className="dashboard-page fade-in">
            {/* Header */}
            <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight mb-2">Tags</h1>
                    <p className="max-w-2xl text-sm leading-6 text-slate-500">
                        Organize contacts and review their stage history
                    </p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                        <select
                            value={selectedPageId || ''}
                            onChange={(e) => {
                                setSelectedPageId(e.target.value);
                                setPage(1);
                                setSelectedIds(new Set());
                                setSelectedShareUserIds(new Set());
                            }}
                            className="input-wireframe w-full h-10"
                        >
                            {pages.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                        <p className="mt-1 font-mono text-[11px] text-gray-500 uppercase tracking-wide">
                            Team Members: {teamLoading ? 'Loading...' : teamMembers.length}
                        </p>
                    </div>

                    <button
                        onClick={() => {
                            setTagName('');
                            setTagColor(TAG_COLORS[0]);
                            setTagOwnerType('page');
                            setTagIsShared(false);
                            setSelectedShareUserIds(new Set());
                            setShowCreateModal(true);
                        }}
                        className="btn-wireframe whitespace-nowrap"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        Create manual tag
                    </button>
                </div>
            </div>

            <div className="mb-6 space-y-4 rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap gap-2" aria-label="Tag categories">{[['manual', 'Manual tags'], ['history', 'Stage history'], ['system', 'Other system tags']].map(([value, label]) => <button key={value} onClick={() => { setTagKind(value); setPage(1); setSelectedIds(new Set()); }} className={`rounded-full border px-3 py-2 text-sm font-medium ${tagKind === value ? 'border-black bg-black text-white' : 'border-gray-200 text-gray-600'}`}>{label}{kindCounts[value] != null ? ` (${kindCounts[value]})` : ''}</button>)}</div>
                <div className="relative max-w-md"><Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" /><input aria-label="Search tags" value={tagSearch} onChange={event => { setTagSearch(event.target.value); setPage(1); }} placeholder="Search tag names" className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm" /></div>
                <p className="text-xs text-gray-500">{tagKind === 'history' ? 'Automatic history tags are retained when a stage changes. They describe past stages; the contact profile shows the current stage.' : tagKind === 'system' ? 'Protected Page defaults and older system tags are retained here.' : 'Tags your team adds to organize contacts. Stage history is kept in its own view.'}</p>
            </div>
            {/* Bulk Actions */}
            {selectedIds.size > 0 && (
                <div className="mb-6 p-4 border border-black bg-gray-50 flex items-center justify-between">
                    <span className="text-sm font-bold uppercase">
                        {selectedIds.size} Selected
                    </span>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setShowBulkDeleteModal(true)}
                            className="btn-wireframe text-xs py-2 px-3 border-red-600 bg-red-50 hover:bg-red-600 hover:text-white"
                        >
                            <Trash2 className="w-3.5 h-3.5 mr-2" />
                            Delete
                        </button>
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            className="btn-ghost-wireframe text-xs uppercase font-bold"
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}

            {/* Tags Grid */}
            {loading ? (
                <div className="flex items-center justify-center h-64 border border-black">
                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
                </div>
            ) : tags.length === 0 ? (
                <div className="wireframe-card text-center py-20">
                    <TagIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-bold uppercase mb-2">No tags found</h3>
                    <p className="text-gray-500 font-mono text-sm mb-6">
                        {tagSearch ? 'Try another search.' : tagKind === 'history' ? 'Stage history appears automatically after a Facebook lead-stage decision is detected.' : tagKind === 'system' ? 'No other system tags for this Page.' : 'Create a manual tag to organize your contacts.'}
                    </p>
                    <button
                        onClick={() => {
                            setTagName('');
                            setTagColor(TAG_COLORS[0]);
                            setTagOwnerType('page');
                            setTagIsShared(false);
                            setSelectedShareUserIds(new Set());
                            setShowCreateModal(true);
                        }}
                        className="btn-wireframe"
                    >
                        Create manual tag
                    </button>
                </div>
            ) : (
                <>
                    <div className="overflow-x-auto border border-black">
                        <table className="table-wireframe">
                            <thead>
                                <tr>
                                    <th className="w-12">
                                        <input
                                            type="checkbox"
                                            checked={tags.some((tag) => !tag.is_default && !tag.system_key) && tags.filter((tag) => !tag.is_default && !tag.system_key).every((tag) => selectedIds.has(tag.id))}
                                            onChange={handleSelectAll}
                                            className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                        />
                                    </th>
                                    <th>Tag Name</th>
                                    <th>Type</th>
                                    <th>Created Date</th>
                                    <th className="w-24 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white">
                                {tags.map((tag) => (
                                    <tr key={tag.id} className="hover:bg-gray-50 transition-colors">
                                        <td>
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.has(tag.id)}
                                                onChange={() => handleSelect(tag.id)}
                                                disabled={Boolean(tag.is_default || tag.system_key)}
                                                className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                            />
                                        </td>
                                        <td>
                                            <div className="flex items-center gap-3">
                                                <span
                                                    className="w-4 h-4 border border-black"
                                                    style={{ backgroundColor: tag.color }}
                                                ></span>
                                                <span className="font-bold">{tag.name}</span>
                                                {tag.is_default && <span className="badge-wireframe bg-gray-100">Default</span>}
                                                {tag.system_key && <span className="badge-wireframe bg-blue-50">{tag.system_key.startsWith('stage_history:') ? 'Smart history' : 'System'}</span>}
                                            </div>
                                        </td>
                                        <td>
                                            <div className="flex items-center gap-2">
                                                <span className={`badge-wireframe ${tag.owner_type === 'user' ? 'bg-gray-100' :
                                                        tag.owner_type === 'page' ? 'bg-black text-white' :
                                                            'bg-white'
                                                    }`}>
                                                    {getOwnerTypeLabel(tag)}
                                                </span>
                                                {tag.owner_type === 'user' && tag.is_shared && (
                                                    <span className="badge-wireframe bg-black text-white">
                                                        Shared
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="font-mono text-xs text-gray-500">
                                            {new Date(tag.created_at).toLocaleDateString()}
                                        </td>
                                        <td>
                                            <div className="flex items-center justify-end gap-1">
                                                <button
                                                    onClick={() => openEditModal(tag)}
                                                    className="btn-ghost-wireframe"
                                                    title="Edit"
                                                >
                                                    <Edit2 className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => openDeleteModal(tag)}
                                                    disabled={Boolean(tag.is_default || tag.system_key)}
                                                    className="btn-ghost-wireframe text-red-600 hover:bg-red-50 hover:text-red-700"
                                                    title={tag.is_default || tag.system_key ? 'System page tags cannot be deleted' : 'Delete'}
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="mt-4 border border-black bg-white p-4">
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            total={total}
                            onPageChange={setPage}
                            onPageSizeChange={(size) => {
                                setPageSize(size);
                                setPage(1);
                            }}
                        />
                    </div>
                </>
            )}

            {/* Create Tag Modal */}
            <Modal
                isOpen={showCreateModal}
                onClose={() => {
                    setShowCreateModal(false);
                    setTagIsShared(false);
                    setSelectedShareUserIds(new Set());
                }}
                title="Create New Tag"
            >
                <div className="space-y-6">
                    <div>
                        <label className="label-wireframe">Tag Name</label>
                        <input
                            type="text"
                            value={tagName}
                            onChange={(e) => setTagName(e.target.value)}
                            placeholder="ENTER TAG NAME"
                            className="input-wireframe"
                            autoFocus
                        />
                    </div>

                    <div>
                        <label className="label-wireframe">Color Label</label>
                        <div className="flex flex-wrap gap-2">
                            {TAG_COLORS.map((color) => (
                                <button
                                    key={color}
                                    onClick={() => setTagColor(color)}
                                    className={`w-8 h-8 border border-black transition-all ${tagColor === color ? 'bg-opacity-100 ring-2 ring-black ring-offset-2' : 'bg-opacity-80 hover:bg-opacity-100'
                                        }`}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="label-wireframe">Scope</label>
                        <div className="grid grid-cols-2 gap-4">
                            <button
                                onClick={() => {
                                    setTagOwnerType('page');
                                    setTagIsShared(false);
                                    setSelectedShareUserIds(new Set());
                                }}
                                className={`border border-black p-4 text-left transition-colors ${tagOwnerType === 'page' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'
                                    }`}
                            >
                                <p className="font-bold text-sm uppercase">Page Tag</p>
                                <p className={`text-xs mt-1 font-mono ${tagOwnerType === 'page' ? 'text-gray-300' : 'text-gray-500'}`}>
                                    Shared with team
                                </p>
                            </button>
                            <button
                                onClick={() => setTagOwnerType('user')}
                                className={`border border-black p-4 text-left transition-colors ${tagOwnerType === 'user' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'
                                    }`}
                            >
                                <p className="font-bold text-sm uppercase">Personal Tag</p>
                                <p className={`text-xs mt-1 font-mono ${tagOwnerType === 'user' ? 'text-gray-300' : 'text-gray-500'}`}>
                                    Private to you
                                </p>
                            </button>
                        </div>
                    </div>

                    {tagOwnerType === 'user' && selectedPageId && (
                        <>
                            <label className="flex items-start gap-3 border border-black p-4 bg-gray-50 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={tagIsShared}
                                    onChange={(e) => setTagIsShared(e.target.checked)}
                                    className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black mt-1"
                                />
                                <div>
                                    <p className="font-bold text-sm uppercase">Share with this page team</p>
                                    <p className="text-xs mt-1 font-mono text-gray-500">
                                        Team size: {teamLoading ? 'Loading...' : teamMembers.length}. Only you can edit or delete this personal tag.
                                    </p>
                                </div>
                            </label>

                            {tagIsShared && (
                                <div className="border border-black p-4 bg-white space-y-3">
                                    <p className="text-xs font-bold uppercase">Optional: choose specific teammates</p>
                                    <p className="text-xs font-mono text-gray-500">
                                        Leave everyone unchecked to share with the full page team.
                                    </p>

                                    {teamLoading ? (
                                        <p className="font-mono text-xs text-gray-500">Loading team members...</p>
                                    ) : selectableTeamMembers.length === 0 ? (
                                        <p className="font-mono text-xs text-gray-500">No other team members found on this page.</p>
                                    ) : (
                                        <div className="max-h-48 overflow-y-auto border border-black">
                                            {selectableTeamMembers.map((member) => (
                                                <label
                                                    key={member.id}
                                                    className="flex items-center gap-3 px-3 py-2 border-b border-gray-200 last:border-b-0 cursor-pointer hover:bg-gray-50"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedShareUserIds.has(member.id)}
                                                        onChange={() => toggleShareMember(member.id)}
                                                        className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                                    />
                                                    <span className="font-mono text-xs">
                                                        {getTeamMemberDisplayName(member)}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => {
                                setShowCreateModal(false);
                                setTagIsShared(false);
                                setSelectedShareUserIds(new Set());
                            }}
                            className="btn-wireframe bg-white text-black hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={!tagName.trim() || actionLoading}
                            className="btn-wireframe bg-black text-white hover:bg-gray-800"
                        >
                            {actionLoading ? 'Creating...' : 'Create Tag'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Edit Tag Modal */}
            <Modal
                isOpen={showEditModal}
                onClose={() => {
                    setShowEditModal(false);
                    setEditingTag(null);
                    setTagIsShared(false);
                    setSelectedShareUserIds(new Set());
                }}
                title="Edit Tag"
            >
                <div className="space-y-6">
                    <div>
                        <label className="label-wireframe">Tag Name</label>
                        <input
                            type="text"
                            value={tagName}
                            onChange={(e) => setTagName(e.target.value)}
                            readOnly={Boolean(editingTag?.is_default || editingTag?.system_key)}
                            className="input-wireframe"
                        />
                        {(editingTag?.is_default || editingTag?.system_key) && <p className="mt-2 text-xs text-gray-500">This system tag can be recolored, but not renamed or deleted.</p>}
                    </div>

                    <div>
                        <label className="label-wireframe">Color Label</label>
                        <div className="flex flex-wrap gap-2">
                            {TAG_COLORS.map((color) => (
                                <button
                                    key={color}
                                    onClick={() => setTagColor(color)}
                                    className={`w-8 h-8 border border-black transition-all ${tagColor === color ? 'bg-opacity-100 ring-2 ring-black ring-offset-2' : 'bg-opacity-80 hover:bg-opacity-100'
                                        }`}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                    </div>

                    {editingTag?.owner_type === 'user' && editingTag.page_id && (
                        <>
                            <label className="flex items-start gap-3 border border-black p-4 bg-gray-50 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={tagIsShared}
                                    onChange={(e) => setTagIsShared(e.target.checked)}
                                    className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black mt-1"
                                />
                                <div>
                                    <p className="font-bold text-sm uppercase">Share with this page team</p>
                                    <p className="text-xs mt-1 font-mono text-gray-500">
                                        Team size: {teamLoading ? 'Loading...' : teamMembers.length}. Ownership stays with you.
                                    </p>
                                </div>
                            </label>

                            {tagIsShared && (
                                <div className="border border-black p-4 bg-white space-y-3">
                                    <p className="text-xs font-bold uppercase">Optional: choose specific teammates</p>
                                    <p className="text-xs font-mono text-gray-500">
                                        Leave everyone unchecked to share with the full page team.
                                    </p>

                                    {teamLoading ? (
                                        <p className="font-mono text-xs text-gray-500">Loading team members...</p>
                                    ) : selectableTeamMembers.length === 0 ? (
                                        <p className="font-mono text-xs text-gray-500">No other team members found on this page.</p>
                                    ) : (
                                        <div className="max-h-48 overflow-y-auto border border-black">
                                            {selectableTeamMembers.map((member) => (
                                                <label
                                                    key={member.id}
                                                    className="flex items-center gap-3 px-3 py-2 border-b border-gray-200 last:border-b-0 cursor-pointer hover:bg-gray-50"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedShareUserIds.has(member.id)}
                                                        onChange={() => toggleShareMember(member.id)}
                                                        className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                                    />
                                                    <span className="font-mono text-xs">
                                                        {getTeamMemberDisplayName(member)}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => {
                                setShowEditModal(false);
                                setEditingTag(null);
                                setTagIsShared(false);
                                setSelectedShareUserIds(new Set());
                            }}
                            className="btn-wireframe bg-white text-black hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleEdit}
                            disabled={!tagName.trim() || actionLoading}
                            className="btn-wireframe bg-black text-white hover:bg-gray-800"
                        >
                            {actionLoading ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Delete Tag Modal */}
            <Modal
                isOpen={showDeleteModal}
                onClose={() => {
                    setShowDeleteModal(false);
                    setEditingTag(null);
                }}
                title="Delete Tag"
            >
                <p className="text-gray-600 mb-6 font-mono text-sm">
                    Are you sure you want to delete <span className="font-bold text-black">&quot;{editingTag?.name}&quot;</span>?
                    This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-black">
                    <button
                        onClick={() => {
                            setShowDeleteModal(false);
                            setEditingTag(null);
                        }}
                        className="btn-wireframe bg-white text-black hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleDelete}
                        disabled={actionLoading}
                        className="btn-wireframe bg-red-600 text-white border-red-600 hover:bg-red-700"
                    >
                        {actionLoading ? 'Deleting...' : 'Delete Tag'}
                    </button>
                </div>
            </Modal>

            {/* Bulk Delete Modal */}
            <Modal
                isOpen={showBulkDeleteModal}
                onClose={() => setShowBulkDeleteModal(false)}
                title="Bulk Delete"
            >
                <p className="text-gray-600 mb-6 font-mono text-sm">
                    Are you sure you want to delete <span className="font-bold text-black">{selectedIds.size} tags</span>?
                    This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-black">
                    <button
                        onClick={() => setShowBulkDeleteModal(false)}
                        className="btn-wireframe bg-white text-black hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleBulkDelete}
                        disabled={actionLoading}
                        className="btn-wireframe bg-red-600 text-white border-red-600 hover:bg-red-700"
                    >
                        {actionLoading ? 'Deleting...' : 'Delete All'}
                    </button>
                </div>
            </Modal>
        </div>
    );
}
