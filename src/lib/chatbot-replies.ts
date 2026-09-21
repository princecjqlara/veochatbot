type SupabaseLike = {
    from: (table: string) => any;
};

export async function claimChatbotReply(
    supabase: SupabaseLike,
    input: { inboundMessageId: string; pageId: string; contactId: string }
): Promise<boolean> {
    const { error } = await supabase
        .from('chatbot_reply_events')
        .insert({
            inbound_message_id: input.inboundMessageId,
            page_id: input.pageId,
            contact_id: input.contactId,
            status: 'processing'
        });

    if (!error) return true;
    if (error.code === '23505') return false;
    throw new Error(error.message || 'Could not claim chatbot reply');
}

export async function finishChatbotReply(
    supabase: SupabaseLike,
    inboundMessageId: string,
    result: { status: 'sent' | 'failed'; outboundMessageId?: string; error?: string }
): Promise<void> {
    const { error } = await supabase
        .from('chatbot_reply_events')
        .update({
            status: result.status,
            outbound_message_id: result.outboundMessageId || null,
            error_message: result.error?.slice(0, 1000) || null,
            updated_at: new Date().toISOString()
        })
        .eq('inbound_message_id', inboundMessageId);

    if (error) throw new Error(error.message || 'Could not finish chatbot reply');
}
