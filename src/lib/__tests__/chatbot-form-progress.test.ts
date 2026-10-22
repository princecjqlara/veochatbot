import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ save:vi.fn(), get:vi.fn(), stage:vi.fn() }));
vi.mock('@/lib/chatbot-control', async original => ({ ...await original<typeof import('@/lib/chatbot-control')>(), saveChatbotContactState:mocks.save, getChatbotContactState:mocks.get }));
vi.mock('@/lib/contact-pipeline', () => ({ updateContactPipelineStage:mocks.stage }));
import { captureCommercialVideoFormProgress, getChatbotDetailProgress } from '@/lib/chatbot-form-progress';
import { extractCommercialVideoFormDetails, mergeCommercialVideoChatDetails, COMMERCIAL_VIDEO_REQUIRED_DETAILS } from '@/lib/chatbot-intake';
import type { ChatbotContactState } from '@/lib/chatbot-control';

const config = { commercial_video_intake_enabled:true };
const form = 'Kindly fill out these details:\n\nBusiness Name: CJ Bakery\nPage / Social Media Link:\nLocation: Manila\nGoal ng Video: Promote fresh bread\nPreferred Video Length: 24s\nPreferred Style:\nContact Number: 0917 123 4567\nPortrait or Landscape? Portrait';
const details = { 'Business Name':'CJ Bakery','Business Location':'Manila','Goal ng video':'Promote fresh bread','Preferred Video Length':'24 seconds','Contact Number':'09171234567','Portrait or Landscape?':'Portrait' };
describe('partial customer forms', () => {
    beforeEach(() => {vi.clearAllMocks();mocks.save.mockResolvedValue(undefined);mocks.stage.mockResolvedValue(true);});
    it('saves filled labels and ignores blank fields without inventing completion', () => {
        expect(extractCommercialVideoFormDetails(form)).toEqual(details);
        expect(getChatbotDetailProgress(config,details)).toMatchObject({collected_count:6,required_count:8,complete:false,missing_details:['Page / Social Media Link','Preferred Style']});
    });
    it('keeps prior values beside blank fields and accepts explicit customer corrections', () => {
        const merged=mergeCommercialVideoChatDetails({...details,'Preferred Style':'Cinematic'},{},[form],'Business Name: New Bakery\nLocation:\nContact Number:');
        expect(merged).toMatchObject({'Business Name':'New Bakery','Business Location':'Manila','Contact Number':'09171234567','Preferred Style':'Cinematic'});
    });
    it('rejects placeholder/invalid answers and supports older numbered labels', () => {
        expect(extractCommercialVideoFormDetails('1. Business Name: Cafe\n2. Business Location: QC\n3. Contact Number: 123\n4. Preferred Style: pending')).toEqual({'Business Name':'Cafe','Business Location':'QC'});
    });
    it('recomputes all missing fields instead of trusting an old complete marker', () => {
        const progress=getChatbotDetailProgress(config,{'Business Name':'CJ Bakery'});
        expect(progress.complete).toBe(false);expect(progress.missing_details).toHaveLength(7);
        expect(progress.missing_details).toEqual(COMMERCIAL_VIDEO_REQUIRED_DETAILS.slice(1));
    });
    it('becomes complete only when every required answer is valid', () => {
        expect(getChatbotDetailProgress(config,{...details,'Page / Social Media Link':'wala pa','Preferred Style':'Cinematic'}).complete).toBe(true);
    });
    it('keeps older/custom answers visible without treating them as completed required fields', () => {
        const progress=getChatbotDetailProgress(config,{business_name:'Cafe',Budget:'5000',Script:'No script','Contact Number':'123'});
        expect(progress).toMatchObject({collected_count:1,saved_count:4,required_count:8,complete:false,
            collected_details:{'Business Name':'Cafe',Budget:'5000',Script:'No script','Contact Number':'123'}});
        expect(progress.collected_details).not.toHaveProperty('business_name');
        expect(progress.missing_details).toContain('Contact Number');
    });
    it('persists partial answers before returning and does not introduce a completion stop', async () => {
        const state={status:'active',collected_details:details,missing_details:['Preferred Style']} as unknown as ChatbotContactState;
        mocks.get.mockResolvedValue(state);
        expect(await captureCommercialVideoFormProgress({from:vi.fn()},{pageId:'page',contactId:'client',existingState:null,customerText:form,inboundAt:'2026-10-21T08:00:00Z'})).toBe(state);
        expect(mocks.save).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({collectedDetails:details,missingDetails:['Page / Social Media Link','Preferred Style']}));
        expect(mocks.save.mock.calls[0][1]).not.toHaveProperty('stopReason');
        expect(mocks.stage).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({stage:'collecting_details',source:'chatbot'}));
        expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.stage.mock.invocationCallOrder[0]);
    });
    it('retains explicit stopped ownership when receiving additional form details', async () => {
        const stopped={status:'stopped',stop_reason:'manual',collected_details:{}} as ChatbotContactState;
        mocks.get.mockResolvedValue(stopped);
        await captureCommercialVideoFormProgress({from:vi.fn()},{pageId:'page',contactId:'client',existingState:stopped,customerText:form,inboundAt:'2026-10-21T08:00:00Z'});
        expect(mocks.save).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({existingState:stopped}));expect(mocks.stage).not.toHaveBeenCalled();
    });
    it('does not write state for an empty form or a simple form request', async () => {
        await captureCommercialVideoFormProgress({from:vi.fn()},{pageId:'page',contactId:'client',existingState:null,customerText:'Please send the form\nBusiness Name:\nContact Number:',inboundAt:'2026-10-21T08:00:00Z'});
        expect(mocks.save).not.toHaveBeenCalled();expect(mocks.stage).not.toHaveBeenCalled();
    });
});
