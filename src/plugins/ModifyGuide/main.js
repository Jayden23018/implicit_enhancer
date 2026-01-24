import { searchGuides } from '../GuideReader/main.js';

export class PluginInstance {
    constructor(agent) {
        this.agent = agent;
        this.lastGuides = [];
        this.lastGuideIndex = 0;
        this.activeGuideIndex = 0;
        this.lastQuery = null;
    }

    init() {
        console.log('ModifyGuide plugin initialized');
    }

    getPluginActions() {
        return [
            {
                name: '!useGuide',
                description: 'Search for a relevant guide and inject it into the agent context, optionally selecting an alternate guide.',
                params: {
                    'query': { type: 'string', description: 'What you want to do (e.g. "stone pickaxe", "smelt iron").' },
                    'alternate': { type: 'boolean', description: 'If true, use the next matching guide instead of the first.' }
                },
                perform: async (agent, query, alternate) => {
                    return await agent.plugin.plugins["ModifyGuide"].applyGuide(query, alternate === true);
                }
            }
        ];
    }

    async autoApplyIfGoal(prompt) {
        if (!prompt || typeof prompt !== 'string') return;
        if (!this.shouldUseGuide(prompt)) return;
        const query = this.extractGoalQuery(prompt);
        if (!query) return;
        await this.applyGuide(query, false, true);
    }

    shouldUseGuide(prompt) {
        const lower = prompt.toLowerCase();
        return /\b(craft|make|build|smelt|forge|create)\b/.test(lower);
    }

    extractGoalQuery(prompt) {
        const line = prompt.split('\n').find(text => text.toLowerCase().includes('goal'));
        const raw = line || prompt;
        return raw.replace(/goal\s*:?/i, '').trim();
    }

    normalizeSteps(guideSteps) {
        if (!Array.isArray(guideSteps)) return [];
        return guideSteps
            .map(step => step.description || step.text || step.step || '')
            .filter(Boolean);
    }

    async refineGuideSteps(query, steps) {
        if (!this.agent?.prompter?.chat_model || typeof this.agent.prompter.chat_model.sendRequest !== 'function') {
            return steps;
        }

        const trimmed = steps.slice(0, 12);
        const prompt = `You are improving Minecraft task guides.\n` +
            `Rewrite the steps to be clearer, concise, and correct for the goal.\n` +
            `Do not add extra goals. Keep steps actionable and sequential.\n` +
            `Return a JSON array of step strings, no extra text.\n` +
            `Goal: "${query}"\n` +
            `Steps:\n- ${trimmed.join('\n- ')}`;

        try {
            const raw = await this.agent.prompter.chat_model.sendRequest([], prompt);
            if (!raw || typeof raw !== 'string') return steps;
            const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
            const parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed)) return steps;
            return parsed.map(step => String(step)).filter(Boolean);
        } catch (error) {
            console.warn('[ModifyGuide] Failed to refine guide steps:', error?.message || error);
            return steps;
        }
    }

    async mergeGuideIntoGoal(goalQuery, guideQuery, guideSteps) {
        if (!this.agent?.prompter?.chat_model || typeof this.agent.prompter.chat_model.sendRequest !== 'function') {
            return guideSteps;
        }

        const trimmed = guideSteps.slice(0, 12);
        const prompt = `You merge guide steps into a larger goal.\n` +
            `Use the guide steps for the prerequisite part, then add remaining steps to complete the goal.\n` +
            `Example: if guide collects stone, append crafting a stone pickaxe.\n` +
            `Return a JSON array of step strings only.\n` +
            `Goal: "${goalQuery}"\n` +
            `Guide topic: "${guideQuery}"\n` +
            `Guide steps:\n- ${trimmed.join('\n- ')}`;

        try {
            const raw = await this.agent.prompter.chat_model.sendRequest([], prompt);
            if (!raw || typeof raw !== 'string') return guideSteps;
            const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
            const parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed)) return guideSteps;
            return parsed.map(step => String(step)).filter(Boolean);
        } catch (error) {
            console.warn('[ModifyGuide] Failed to merge guide into goal:', error?.message || error);
            return guideSteps;
        }
    }

    buildGuideMessage(query, guideSteps, guideIndex, totalGuides, autoInjected) {
        const stepsText = guideSteps.map((step, index) => `${index + 1}. ${step}`).join('\n');
        const usage = 'Use these steps to plan actions and required materials.';
        const origin = autoInjected ? 'Auto guide injection.' : 'Guide injected by command.';
        const header = `Guide for "${query}" (${guideIndex + 1}/${totalGuides})`;
        return `${header}\n${stepsText}\n${usage}\n${origin}`;
    }

    normalizeGuideQuery(query) {
        const lower = (query || '').toLowerCase();
        if (lower.includes('stone_pickaxe') || lower.includes('stone pickaxe')) {
            return 'stone age';
        }
        return query;
    }

    async applyGuide(query, alternate, autoInjected = false) {
        const sanitizedQuery = (query || '').trim();
        if (!sanitizedQuery) {
            return 'No guide query provided.';
        }

        const guideQuery = this.normalizeGuideQuery(sanitizedQuery);

        let guides = [];
        try {
            guides = await searchGuides(guideQuery, this.agent);
        } catch (error) {
            const errorMsg = `Error searching guides: ${error.message}`;
            console.error(errorMsg);
            return errorMsg;
        }

        if (!guides || guides.length === 0) {
            const msg = `No guides found for "${guideQuery}".`;
            if (this.agent?.history) {
                await this.agent.history.add('system', msg);
            }
            return msg;
        }

        if (this.lastQuery !== guideQuery) {
            this.lastGuides = guides;
            this.lastGuideIndex = 0;
            this.activeGuideIndex = 0;
            this.lastQuery = guideQuery;
        } else if (alternate) {
            this.lastGuideIndex = (this.lastGuideIndex + 1) % guides.length;
            this.activeGuideIndex = this.lastGuideIndex;
        }

        const guideIndex = this.activeGuideIndex;
        const rawSteps = this.normalizeSteps(guides[guideIndex]);
        const refinedSteps = await this.refineGuideSteps(sanitizedQuery, rawSteps);
        if (refinedSteps.length === 0) {
            return `Guide lookup for "${guideQuery}" returned no usable steps.`;
        }
        const mergedSteps = await this.mergeGuideIntoGoal(sanitizedQuery, guideQuery, refinedSteps);
        const finalSteps = mergedSteps.length > 0 ? mergedSteps : refinedSteps;
        const guideMessage = this.buildGuideMessage(sanitizedQuery, finalSteps, guideIndex, guides.length, autoInjected);

        if (this.agent?.history) {
            await this.agent.history.add('system', guideMessage);
        }

        return guideMessage;
    }
}
