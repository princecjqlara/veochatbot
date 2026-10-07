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
    if (error.code === '23505') {
        // Retry only a known failure that delivered nothing. The conditional
        // update lets only one simultaneous webhook retry acquire the claim.
        const { data, error: retryError } = await supabase.from('chatbot_reply_events')
            .update({ status: 'processing', error_message: null, updated_at: new Date().toISOString() })
            .eq('inbound_message_id', input.inboundMessageId)
            .eq('page_id', input.pageId).eq('contact_id', input.contactId)
            .eq('status', 'failed').is('outbound_message_id', null).select('inbound_message_id').maybeSingle();
        if (retryError) throw new Error(retryError.message || 'Could not retry chatbot reply');
        return Boolean(data);
    }
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
