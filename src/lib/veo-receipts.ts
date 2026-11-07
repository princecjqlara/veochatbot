export const receiptHoldLabels: Record<string, string> = {
    converted_lead_required: 'Set the contact lead stage to Converted',
    create_and_link_order: 'Create an order and link it to this receipt',
    verify_full_payment: 'Verify the full payment and mark the order paid',
    seller_or_order_attribution_changed: 'Review the seller and order attribution',
    photo_expired_reupload: 'The temporary photo expired; upload it again',
    staff_or_page_access_changed: 'Review the staff account and Page permissions',
    telegram_mapping_required: 'An authorized supervisor must complete the Telegram mapping'
};
export function receiptPhoto(file: File, bytes: Uint8Array) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 3 * 1024 * 1024) throw Error('Choose a JPG, PNG or WebP receipt up to 3 MB');
    const valid = file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 : file.type === 'image/png' ? bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10' : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!valid) throw Error('Photo contents do not match the image type');
}
