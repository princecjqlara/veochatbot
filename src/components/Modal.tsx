'use client';

import { X } from 'lucide-react';
import { ReactNode, useEffect, useId, useRef } from 'react';

const openDialogs: HTMLElement[] = [];
let savedBodyOverflow = '';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children?: ReactNode;
    size?: 'sm' | 'md' | 'lg' | 'xl';
}

export default function Modal({
    isOpen,
    onClose,
    title,
    children,
    size = 'md'
}: ModalProps) {
    const onCloseRef = useRef(onClose);
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!isOpen || !dialogRef.current) return;
        const dialog = dialogRef.current, previousFocus = document.activeElement as HTMLElement | null;
        if (!openDialogs.length) { savedBodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
        openDialogs.push(dialog);
        const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')).filter(element => !element.matches(':disabled, [tabindex="-1"]') && !element.closest('[hidden]') && element.getClientRects().length > 0);
        (focusable()[0] || dialog).focus();
        const handleKey = (event: KeyboardEvent) => {
            if (openDialogs.at(-1) !== dialog) return;
            if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
            if (event.key !== 'Tab') return;
            const elements = focusable(), first = elements[0], last = elements.at(-1);
            if (!first) { event.preventDefault(); dialog.focus(); }
            else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last!.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('keydown', handleKey);
            const wasTop = openDialogs.at(-1) === dialog;
            const index = openDialogs.indexOf(dialog);
            if (index >= 0) openDialogs.splice(index, 1);
            if (!openDialogs.length) document.body.style.overflow = savedBodyOverflow;
            if (wasTop && previousFocus?.isConnected) previousFocus.focus();
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const sizeClasses = {
        sm: 'max-w-sm',
        md: 'max-w-md',
        lg: 'max-w-lg',
        xl: 'max-w-xl'
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? titleId : undefined}
                aria-label={title ? undefined : 'Dialog'}
                tabIndex={-1}
                className={`modal ${sizeClasses[size]} outline-none`}
                onClick={(e) => e.stopPropagation()}
            >
                {title && (
                    <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/70 p-4 sm:p-6">
                        <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
                        <button
                            onClick={onClose}
                            type="button"
                            aria-label="Close"
                            className="btn-ghost-wireframe shrink-0 p-1 hover:bg-slate-200"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                )}
                <div className="p-4 sm:p-6">{children}</div>
            </div>
        </div>
    );
}
