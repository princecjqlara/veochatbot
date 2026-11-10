'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange?: (pageSize: number) => void;
}

export default function Pagination({
    page,
    pageSize,
    total,
    onPageChange,
    onPageSizeChange
}: PaginationProps) {
    const totalPages = Math.ceil(total / pageSize);
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);

    const getVisiblePages = () => {
        const pages: (number | string)[] = [];
        const showEllipsis = totalPages > 7;

        if (!showEllipsis) {
            for (let i = 1; i <= totalPages; i++) {
                pages.push(i);
            }
        } else {
            if (page <= 4) {
                for (let i = 1; i <= 5; i++) pages.push(i);
                pages.push('...');
                pages.push(totalPages);
            } else if (page >= totalPages - 3) {
                pages.push(1);
                pages.push('...');
                for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
            } else {
                pages.push(1);
                pages.push('...');
                for (let i = page - 1; i <= page + 1; i++) pages.push(i);
                pages.push('...');
                pages.push(totalPages);
            }
        }

        return pages;
    };

    if (total === 0) return null;

    return (
        <nav aria-label="Pagination" className="flex flex-col items-start justify-between gap-4 border-t border-slate-200 py-4 sm:flex-row sm:items-center">
            <div className="flex flex-wrap items-center gap-4">
                <span aria-live="polite" className="text-xs text-slate-500">
                    Showing <span className="text-black font-bold">{from}</span> - <span className="text-black font-bold">{to}</span> of{' '}
                    <span className="text-black font-bold">{total}</span>
                </span>

                {onPageSizeChange && (
                    <select
                        aria-label="Rows per page"
                        value={pageSize}
                        onChange={(e) => onPageSizeChange(Number(e.target.value))}
                        className="h-9 rounded-lg border bg-white px-2 text-xs font-medium"
                    >
                        <option value={10}>10 / PAGE</option>
                        <option value={25}>25 / PAGE</option>
                        <option value={50}>50 / PAGE</option>
                        <option value={100}>100 / PAGE</option>
                    </select>
                )}
            </div>

            <div className="flex max-w-full flex-wrap items-center gap-1">
                <button
                    type="button"
                    aria-label="Previous page"
                    onClick={() => onPageChange(page - 1)}
                    disabled={page <= 1}
                    className="btn-ghost-wireframe h-9 w-9 border p-0 disabled:cursor-not-allowed disabled:opacity-30"
                >
                    <ChevronLeft className="w-4 h-4" />
                </button>

                {getVisiblePages().map((p, i) =>
                    typeof p === 'number' ? (
                        <button
                            type="button"
                            aria-label={`Page ${p}`}
                            aria-current={p === page ? 'page' : undefined}
                            key={i}
                            onClick={() => onPageChange(p)}
                            className={`h-9 min-w-9 rounded-lg border px-2 text-xs font-semibold transition-colors ${p === page
                                    ? 'border-indigo-600 bg-indigo-600 text-white'
                                    : 'bg-white text-slate-600 hover:bg-slate-100'
                                }`}
                        >
                            {p}
                        </button>
                    ) : (
                        <span key={i} className="px-2 text-gray-500">
                            {p}
                        </span>
                    )
                )}

                <button
                    type="button"
                    aria-label="Next page"
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages}
                    className="btn-ghost-wireframe h-9 w-9 border p-0 disabled:cursor-not-allowed disabled:opacity-30"
                >
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>
        </nav>
    );
}
