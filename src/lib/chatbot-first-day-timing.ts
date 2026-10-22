// Owner-selected experiment parameters. Historical results support testing an
// early reminder; these exact gaps are not fitted response-maximizing timings.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const FIRST_DAY_TIMING = {
    firstDelayMinutes: 45,
    afterPageMinutes: 30,
    minimumGapMinutes: 120,
    baseGapMinutes: 180,
    growthFactor: 1.5,
    maximumGapMinutes: 360,
    deadlineBufferMinutes: 10,
    utcOffsetMinutes: 480,
    wakingStartHour: 8,
    wakingEndHour: 21
} as const;

export type FirstDayTimingSettings = { [K in keyof typeof FIRST_DAY_TIMING]: number };

export function firstDayDeadline(firstInquiry: number, settings: FirstDayTimingSettings = FIRST_DAY_TIMING) {
    return firstInquiry + 24 * HOUR - settings.deadlineBufferMinutes * MINUTE;
}

export function nextFirstDayWakingTime(time: number, settings: FirstDayTimingSettings = FIRST_DAY_TIMING) {
    const local = new Date(time + settings.utcOffsetMinutes * MINUTE);
    const hour = local.getUTCHours();
    if (hour >= settings.wakingStartHour && hour < settings.wakingEndHour) return time;
    local.setUTCHours(hour < settings.wakingStartHour ? settings.wakingStartHour : 24 + settings.wakingStartHour, 0, 0, 0);
    return local.getTime() - settings.utcOffsetMinutes * MINUTE;
}

export function getFirstDayCandidate(input: {
    firstInquiry: number;
    initialReplyEnd: number;
    lastOutbound: number;
    now: number;
    sequenceIndex: number;
    previousSentAt?: number;
    settings?: FirstDayTimingSettings;
}): number | null {
    const settings = { ...FIRST_DAY_TIMING, ...input.settings };
    if (![input.firstInquiry, input.initialReplyEnd, input.lastOutbound, input.now].every(Number.isFinite) ||
        !Number.isInteger(input.sequenceIndex) || input.sequenceIndex < 0) return null;
    if (input.initialReplyEnd < input.firstInquiry || input.lastOutbound < input.initialReplyEnd ||
        input.lastOutbound > input.now) return null;
    if (Object.values(settings).some(value => !Number.isFinite(value)) ||
        settings.minimumGapMinutes < 1 || settings.baseGapMinutes < 1 ||
        settings.firstDelayMinutes < 1 || settings.afterPageMinutes < 1 ||
        settings.growthFactor < 1 || settings.maximumGapMinutes < settings.minimumGapMinutes ||
        settings.deadlineBufferMinutes < 0 || settings.deadlineBufferMinutes >= 1440 ||
        !Number.isInteger(settings.wakingStartHour) || !Number.isInteger(settings.wakingEndHour) ||
        settings.wakingStartHour < 0 || settings.wakingEndHour > 24 ||
        settings.wakingStartHour >= settings.wakingEndHour) return null;
    let earliest: number;
    if (input.sequenceIndex === 0) {
        earliest = Math.max(
            input.firstInquiry + settings.firstDelayMinutes * MINUTE,
            input.initialReplyEnd + settings.afterPageMinutes * MINUTE
        );
    } else {
        if (!Number.isFinite(input.previousSentAt) ||
            input.previousSentAt! < input.firstInquiry || input.previousSentAt! > input.now) return null;
        const gap = Math.max(settings.minimumGapMinutes, Math.min(settings.maximumGapMinutes,
            settings.baseGapMinutes * settings.growthFactor ** (input.sequenceIndex - 1)));
        earliest = input.previousSentAt! + gap * MINUTE;
    }
    const candidate = nextFirstDayWakingTime(Math.max(earliest, input.lastOutbound + settings.afterPageMinutes * MINUTE, input.now), settings);
    return candidate < firstDayDeadline(input.firstInquiry, settings) ? candidate : null;
}

export function buildFirstDaySchedule(input: {
    firstInquiry: number;
    initialReplyEnd: number;
    lastOutbound: number;
    now: number;
    sentTimes?: number[];
    settings?: FirstDayTimingSettings;
}): Array<{ sequenceIndex: number; dueAt: string }> {
    const actual = [...new Set(input.sentTimes || [])].sort((a, b) => a - b);
    if (actual.some(time => !Number.isFinite(time) || time < input.firstInquiry || time > input.now)) return [];
    const opportunities: Array<{ sequenceIndex: number; dueAt: string }> = [];
    let sequenceIndex = actual.length;
    let previousSentAt = actual.at(-1);
    let planningNow = input.now;
    // Positive gaps and the elapsed-day deadline bound the loop; there is no
    // configured or hidden maximum number of follow-ups.
    while (true) {
        const candidate = getFirstDayCandidate({ ...input, now: planningNow, sequenceIndex, previousSentAt });
        if (candidate === null) return opportunities;
        opportunities.push({ sequenceIndex, dueAt: new Date(candidate).toISOString() });
        previousSentAt = candidate;
        planningNow = candidate;
        sequenceIndex++;
    }
}
