/** The saved lead label can lag behind order creation. Check business records
 * independently, and fail closed if that check is unavailable. */
export async function getChatbotSalesStopReason(db: { rpc?: (name: string, args: Record<string, unknown>) => any }, pageId: string, contactId: string): Promise<'converted' | 'order_created' | null> {
    if (!db.rpc) throw Error('Order eligibility check is unavailable');
    const result = await db.rpc('chatbot_contact_sales_stop', { p_page: pageId, p_contact: contactId });
    if (result.error) throw Error('Order eligibility check is unavailable');
    if (result.data === null || result.data === 'converted' || result.data === 'order_created') return result.data;
    throw Error('Order eligibility check returned an invalid result');
}
