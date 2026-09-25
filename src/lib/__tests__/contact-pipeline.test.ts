import { describe, expect, it } from 'vitest';
import {
    isPipelineClosedForAutomation,
    pipelineStageForChatbotProgress,
    pipelineStageForMessengerSignal,
    shouldAutoMovePipeline
} from '@/lib/contact-pipeline';

describe('contact pipeline', () => {
    it('maps bot progress to the appropriate stage', () => {
        expect(pipelineStageForChatbotProgress({})).toBe('engaged');
        expect(pipelineStageForChatbotProgress({ collectedDetails: { email: 'a@example.com' } })).toBe('collecting_details');
        expect(pipelineStageForChatbotProgress({ detailsComplete: true })).toBe('qualified');
        expect(pipelineStageForChatbotProgress({ stopReason: 'refusal' })).toBe('not_qualified');
        expect(pipelineStageForChatbotProgress({ stopReason: 'opt_out' })).toBe('opted_out');
    });

    it('maps all Messenger lead-stage signals directly', () => {
        expect(pipelineStageForMessengerSignal('qualified')).toBe('qualified');
        expect(pipelineStageForMessengerSignal('order_created')).toBe('order_created');
        expect(pipelineStageForMessengerSignal('converted')).toBe('converted');
        expect(pipelineStageForMessengerSignal('not_qualified')).toBe('not_qualified');
    });

    it('moves forward automatically without regressing successful contacts', () => {
        expect(shouldAutoMovePipeline('new', 'engaged')).toBe(true);
        expect(shouldAutoMovePipeline('qualified', 'collecting_details')).toBe(false);
        expect(shouldAutoMovePipeline('order_created', 'not_qualified')).toBe(false);
        expect(shouldAutoMovePipeline('not_qualified', 'qualified')).toBe(true);
        expect(shouldAutoMovePipeline('converted', 'qualified')).toBe(false);
        expect(shouldAutoMovePipeline('engaged', 'opted_out')).toBe(true);
    });

    it('closes completed and terminal stages to bot automation', () => {
        expect(isPipelineClosedForAutomation('new')).toBe(false);
        expect(isPipelineClosedForAutomation('engaged')).toBe(false);
        expect(isPipelineClosedForAutomation('collecting_details')).toBe(false);
        expect(isPipelineClosedForAutomation('qualified')).toBe(true);
        expect(isPipelineClosedForAutomation('order_created')).toBe(true);
        expect(isPipelineClosedForAutomation('converted')).toBe(true);
        expect(isPipelineClosedForAutomation('not_qualified')).toBe(true);
        expect(isPipelineClosedForAutomation('opted_out')).toBe(true);
    });
});
