export type TestSource = { document_id: string; title: string; similarity: number };
export type TestMedia = {
    id: string;
    title: string;
    media_type: 'image' | 'video';
    usage_notes?: string;
    preview_url?: string | null;
    target_url?: string | null;
    source?: 'google_drive';
};
export type TestFolder = { id: string; name: string; folder_url: string; button_text: string };
export type TestChatMessage = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    label?: string;
    sources?: TestSource[];
    media?: TestMedia | null;
    mediaItems?: TestMedia[];
    folder?: TestFolder | null;
    previewOnly?: boolean;
};

type TestReply = {
    reply?: unknown;
    messages?: unknown;
    sources?: TestSource[];
    media?: TestMedia | null;
    media_items?: TestMedia[];
    folder?: TestFolder | null;
};

/** Preserve generated bubbles and mirror the live text/card/question order. */
export function buildChatbotTestMessages(result: TestReply, options: {
    idPrefix: string; label?: string; commercialVideoIntake?: boolean;
}): TestChatMessage[] {
    const parts = Array.isArray(result.messages) && result.messages.length ? result.messages : [result.reply];
    const replies = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    const messages: TestChatMessage[] = replies.map((content, index) => ({
        id: `${options.idPrefix}-${index}`, role: 'assistant', content,
        ...(options.label ? { label: options.label } : {})
    }));
    const finalText = messages.at(-1);
    if (finalText) {
        finalText.sources = Array.isArray(result.sources) ? result.sources : [];
        finalText.folder = result.folder || null;
    }
    const mediaItems = Array.isArray(result.media_items) && result.media_items.length
        ? result.media_items : result.media ? [result.media] : [];
    if (mediaItems.length) {
        const deferQuestion = options.commercialVideoIntake && messages.length > 1 && /\?\s*$/.test(finalText!.content);
        messages.splice(messages.length - (deferQuestion ? 1 : 0), 0, {
            id: `${options.idPrefix}-media`, role: 'assistant', content: '',
            media: mediaItems[0], mediaItems,
            ...(options.label ? { label: options.label } : {})
        });
    }
    return messages;
}

/** UI demonstrations and media-only cards are not customer conversation turns. */
export function getChatbotTestHistory(messages: TestChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
    return messages.filter(message => !message.previewOnly && message.content.trim())
        .map(({ role, content }) => ({ role, content }));
}
