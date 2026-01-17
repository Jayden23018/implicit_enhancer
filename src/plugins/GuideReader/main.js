const BASE_URL = 'https://minecraft-ai-embodied-benchmark.megrez.plus/api';

export async function getAdvancements() {
    try {
        const response = await fetch(`${BASE_URL}/advancements`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error('Error fetching advancements:', error);
        throw error;
    }
}

async function semanticGuideMatch(query, guideKeys, agent) {
    if (!agent || !agent.prompter || !agent.prompter.chat_model || typeof agent.prompter.chat_model.sendRequest !== 'function') {
        return null;
    }

    const shortlist = guideKeys.slice(0, 40); // keep prompt compact
    const prompt = `You match Minecraft guide titles to a user query.\n` +
        `Pick the single closest guide id from the list.\n` +
        `Query: "${query}"\n` +
        `Guide IDs:\n- ${shortlist.join('\n- ')}\n` +
        `Return only the guide id string.`;

    try {
        const raw = await agent.prompter.chat_model.sendRequest([], prompt);
        if (!raw) return null;
        const cleaned = raw.trim().toLowerCase();
        const found = shortlist.find(k => cleaned.includes(k.toLowerCase()));
        return found || null;
    } catch (err) {
        console.warn('[GuideSearch] Semantic match failed:', err?.message || err);
        return null;
    }
}

export async function searchGuides(query, agent = null) {
    try {
        const [advancementsData, guidesResponse] = await Promise.all([
            getAdvancements().catch(() => ({ advancements: [] })),
            fetch(`${BASE_URL}/guides`)
        ]);

        if (!guidesResponse.ok) {
            throw new Error(`HTTP error! status: ${guidesResponse.status}`);
        }
        const allGuides = await guidesResponse.json();

        const lowerQuery = query.toLowerCase();
        const relevantSlugs = new Set();

        if (advancementsData && advancementsData.advancements) {
            for (const adv of advancementsData.advancements) {
                if (adv.name && adv.name.toLowerCase().includes(lowerQuery)) {
                    relevantSlugs.add(adv.slug);
                    if (adv.slug.includes('/')) {
                        relevantSlugs.add(adv.slug.split('/').pop());
                    }
                }
            }
        }

        const results = [];

        for (const [id, steps] of Object.entries(allGuides)) {
            const lowerId = id.toLowerCase();

            let isRelevantSlug = false;
            for (const slug of relevantSlugs) {
                if (lowerId.includes(slug.toLowerCase())) {
                    isRelevantSlug = true;
                    break;
                }
            }
            if (isRelevantSlug) {
                results.push(steps);
                continue;
            }

            if (lowerId.includes(lowerQuery)) {
                results.push(steps);
                continue;
            }

            const descriptionMatch = steps.some(step =>
                step.description && step.description.toLowerCase().includes(lowerQuery)
            );
            if (descriptionMatch) {
                results.push(steps);
            }
        }

        if (results.length === 0) {
            const semanticId = await semanticGuideMatch(query, Object.keys(allGuides), agent);
            if (semanticId && allGuides[semanticId]) {
                results.push(allGuides[semanticId]);
                console.log(`[GuideSearch] Semantic match selected "${semanticId}" for "${query}"`);
            }
        }

        console.log(`[GuideSearch] Query: "${query}" | Results: ${results.length}`);
        return results;
    } catch (error) {
        console.error('Error searching guides:', error);
        throw error;
    }
}

export class PluginInstance {
    constructor(agent) {
        this.agent = agent;
    }

    init() {
        console.log('GuideReader plugin initialized');
    }

    getPluginActions() {
        return [
            {
                name: '!searchGuide',
                description: 'Search for a guide on how to do something in Minecraft from the online benchmark database.',
                params: {
                    'query': { type: 'string', description: 'The topic or item to search for (e.g. "crafting table", "kill zombie").' },
                },
                perform: async function (agent, query) {
                    await agent.bot.chat(`Searching for guides about "${query}"...`);
                    try {
                        const guides = await searchGuides(query, agent);
                        if (guides && guides.length > 0) {
                            const guide = guides[0];
                            let output = `Found guide for "${query}":\n`;

                            if (Array.isArray(guide)) {
                                output += guide.map(step =>
                                    `${step.step}. ${step.description}`
                                ).join('\n');
                            } else if (guide.description) {
                                output += guide.description;
                            }

                            agent.history.add('system', output);
                            console.log(`[GuideReader] ${output}`);
                            return output;
                        } else {
                            const msg = `No guides found for "${query}".`;
                            agent.history.add('system', msg);
                            return msg;
                        }
                    } catch (error) {
                        const errMsg = `Error searching guides: ${error.message}`;
                        console.error(errMsg);
                        agent.history.add('system', errMsg);
                        return errMsg;
                    }
                }
            },
        ]
    }
}
