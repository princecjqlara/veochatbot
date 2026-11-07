/** Integer money parsing shared by browser previews and server validation. */
export function parseMoneyMinor(value: unknown): number {
    const text = String(value ?? '').trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a positive amount with at most two decimal places');
    const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000_000) throw new Error('Payment amount is outside the supported range');
    return amount;
}
