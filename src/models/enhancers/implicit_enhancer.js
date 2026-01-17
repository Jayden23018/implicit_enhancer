import { join, dirname } from 'path';
import { promises as fs, readFileSync } from 'fs';
import { Enhancer } from './enhancer.js';
import { Local } from '../local.js';
import { Doubao } from '../doubao.js';
import { Qwen } from '../qwen.js';
import { SharedMemory } from '../../team/shared_memory.js';
import { actionsList } from '../../agent/commands/actions.js';

// Intent -> training file mapping
const INTENT_TO_TRAINING_FILE = {
    BUILD: 'build_examples.json',
    CRAFT: 'crafting_examples.json',
    COOK: 'cooking_examples.json',
    COLLECT: 'craft_examples.json',
    COMBAT: 'combat_examples.json',
    DEFAULT: 'build_examples.json'
};

export class ImplicitEnhancer {
    constructor(config) {
        if (!config.enhancer) {
            throw new Error('ImplicitEnhancer requires an Enhancer instance in config');
        }

        this.agent = config.agent;
        this.debug = Boolean(config.enhancer?.debug);
        this.activeMission = {
            isActive: false,
            planName: null,
            steps: [],
            currentStep: 0,
            failures: 0
        };

        let modelInstance = null;
        const modelConfig = config.enhancer.model;
        switch (modelConfig.api) {
            case 'ollama':
                modelInstance = new Local(modelConfig.model, modelConfig.url);
                break;
            case 'doubao':
                modelInstance = new Doubao(modelConfig.model, modelConfig.url);
                break;
            case 'qwen':
                modelInstance = new Qwen(modelConfig.model, modelConfig.url, modelConfig.params);
                break;
            default:
                throw new Error(`Unsupported model API: ${modelConfig.api}`);
        }

        const enhancerConfig = { ...config.enhancer, model: modelInstance };
        this.innerEnhancer = new Enhancer(enhancerConfig);
        this.trainingDir = join(process.cwd(), 'data', 'training');
        this.memoryDir = join(process.cwd(), 'data', 'memory');

        const teamOptions = config.team || {};
        this.sharedMemory = new SharedMemory({
            agentName: this.agent?.name,
            path: teamOptions.shared_state_path
        });
        this.enableTeamContext = teamOptions.enable !== false; // default on
    }

    logDebug(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }

    resetMission() {
        this.activeMission = {
            isActive: false,
            planName: null,
            steps: [],
            currentStep: 0,
            failures: 0
        };
    }

    updateMissionState(lastResponseText) {
        if (!this.activeMission.isActive) return;

        const { steps, currentStep } = this.activeMission;
        if (!steps || steps.length === 0) {
            this.resetMission();
            return;
        }

        const step = steps[currentStep];
        const expectedCmd = step?.action_cmd?.[0];
        const responseText = lastResponseText || '';

        const errorDetected = /error|failed|fail|cannot/i.test(responseText);
        const issuedExpected = expectedCmd ? responseText.includes(expectedCmd) : true;
        const likelySuccess = issuedExpected && !errorDetected;

        if (likelySuccess) {
            this.activeMission.currentStep += 1;
            this.activeMission.failures = 0;
        } else {
            this.activeMission.failures += 1;
        }

        if (this.activeMission.currentStep >= steps.length) {
            this.resetMission();
        }
    }

    async getRelevantTrainingFiles(intent) {
        if (!intent) return [];
        const relevantFiles = new Set();

        const mainIntentFile = INTENT_TO_TRAINING_FILE[intent.type] || INTENT_TO_TRAINING_FILE.DEFAULT;
        relevantFiles.add(join(this.trainingDir, mainIntentFile));

        if (intent.subtype === 'RESOURCE_GATHERING') {
            relevantFiles.add(join(this.trainingDir, INTENT_TO_TRAINING_FILE.COLLECT));
        }

        switch (intent.type) {
            case 'BUILD':
                relevantFiles.add(join(this.trainingDir, INTENT_TO_TRAINING_FILE.CRAFT));
                break;
            case 'CRAFT':
            case 'COOK':
                relevantFiles.add(join(this.trainingDir, INTENT_TO_TRAINING_FILE.COLLECT));
                break;
        }

        return Array.from(relevantFiles).filter(file => {
            try { readFileSync(file); return true; }
            catch { return false; }
        });
    }

    async sendRequest(model, turns, systemPrompt, stop_seq = '***') {
        const lastAssistantTurn = [...(turns || [])].reverse().find(t => t.role === 'assistant' && t.content);
        this.updateMissionState(lastAssistantTurn?.content);

        const intent = await this.getIntent(turns, systemPrompt);
        const info = await this.getRelevantInfo(intent);
        const teamTasks = await this.getTeamContext();

        const prompt = await this.improvePrompt(intent, info, systemPrompt, teamTasks);

        this.logDebug(`[ImplicitEnhancer] agent=${this.agent?.name || 'unknown'} intent=${intent?.type || 'unknown'} currentStep=${this.activeMission.currentStep} teamTasks=${teamTasks.length} promptPreview="${prompt.slice(0, 120)}..."`);

        if (intent && this.sharedMemory && this.enableTeamContext) {
            const task = this.sharedMemory.claimTask({
                agent: this.agent?.name,
                intent,
                summary: intent.input,
                status: 'planning'
            });
            this.lastClaimedTaskId = task?.id;
        }

        const res = await this.innerEnhancer.sendRequest(model, turns.slice(-3), prompt, stop_seq);

        this.markTaskInProgress({ lastResponse: res });
        await this.saveRelevantInfo(intent, res);

        const normalizedRes = this.normalizeCommandsInResponse(res);
        const adjustedRes = await this.applyTaskOverrides(normalizedRes);
        return adjustedRes;
    }

    markTaskInProgress(extra = {}) {
        if (this.lastClaimedTaskId && this.sharedMemory && this.enableTeamContext) {
            this.sharedMemory.updateStatus(this.lastClaimedTaskId, 'in_progress', { ...extra });
        }
    }

    markTaskDone(result) {
        if (this.lastClaimedTaskId && this.sharedMemory && this.enableTeamContext) {
            this.sharedMemory.completeTask(this.lastClaimedTaskId, result);
        }
    }

    markTaskFailed(reason) {
        if (this.lastClaimedTaskId && this.sharedMemory && this.enableTeamContext) {
            this.sharedMemory.updateStatus(this.lastClaimedTaskId, 'failed', { reason });
        }
    }

    async getTeamContext() {
        if (!this.sharedMemory || !this.enableTeamContext) return [];
        return this.sharedMemory.listActive({ excludeAgent: this.agent?.name });
    }

    buildCommandReference() {
        let reference = '\n## Command Reference & Syntax\n';
        reference += 'Commands use parentheses and double quotes for strings. Examples:\n';
        reference += '- !collectBlocks("block_type", count)\n';
        reference += '- !craftRecipe("recipe_name", count)\n';
        reference += '- !smeltItem("raw_item", count)\n';
        reference += '- !searchForBlock("block_type", search_range)\n';
        reference += '- !inventory\n';
        return reference;
    }

    buildItemNameGuide() {
        return '';
    }

    async getIntent(turns, systemPrompt) {
        if (!turns || turns.length === 0) return null;

        const lastUserMessage = [...turns].reverse().find(msg => msg.role === 'user' && msg.content?.trim().length > 0);
        if (!lastUserMessage) return null;

        const userInput = lastUserMessage.content;
        let intentAnalysis;
        try {
            intentAnalysis = await this.determineIntentType(userInput);
        } catch (err) {
            console.warn('Intent analysis failed:', err);
            intentAnalysis = { type: 'GENERAL', subtype: 'unknown' };
        }

        return {
            id: `intent_${Date.now()}`,
            source: 'user',
            input: userInput,
            type: intentAnalysis.type,
            subtype: intentAnalysis.subtype
        };
    }

    async determineIntentType(input) {
        const analysisPrompt = {
            role: 'system',
            content: `You are an intent analyzer for a Minecraft AI agent. Analyze the given input and determine the user's intent.
Categorize the intent into one of these types: BUILD, CRAFT, COOK, COLLECT, COMBAT, EXPLORE, INTERACT, GENERAL.
Provide JSON with fields: type, subtype. Only return JSON.`
        };

        const userMessage = { role: 'user', content: input };

        try {
            const analysis = await this.innerEnhancer.sendRequest(null, [userMessage], analysisPrompt.content, '***');
            const match = analysis.match(/\{[\s\S]*\}/);
            const jsonText = match ? match[0] : '{}';
            const result = JSON.parse(jsonText);
            return { type: result.type, subtype: result.subtype };
        } catch (error) {
            console.warn('Intent analysis failed:', error);
            return { type: 'GENERAL', subtype: 'unknown' };
        }
    }

    async getRelevantInfo(intent) {
        if (!intent) return [];

        const relevantFiles = await this.getRelevantTrainingFiles(intent);
        let allExamples = [];

        for (const filePath of relevantFiles) {
            try {
                const trainingData = JSON.parse(readFileSync(filePath, 'utf8'));
                allExamples = allExamples.concat(trainingData.map((ex, i) => ({
                    ...ex,
                    id: `${filePath}_${i}`,
                    source_file: filePath,
                    plan: ex.plan || []
                })));
                this.logDebug(`[ImplicitEnhancer] loaded training examples from ${filePath}, count=${trainingData.length}`);
            } catch (err) {
                console.warn(`Failed to load training data from ${filePath}:`, err);
            }
        }
        return allExamples;
    }

    injectMiningKnowledge(targetBlock) {
        if (!targetBlock) return '';
        try {
            const bot = this.agent?.bot;
            if (!bot?.registry?.blocksByName) return '';
            const block = bot.registry.blocksByName[targetBlock.toLowerCase()];
            if (!block) return '';
            const tools = block.harvestTools || {};
            const toolNames = Object.keys(tools)
                .map(id => bot.registry.items[id]?.name)
                .filter(Boolean);
            if (toolNames.length === 0) return '';
            const best = toolNames[0];
            return `⚠️ INFO: To mine ${targetBlock}, you MUST equip ${best} (or better). Do NOT use hand/wood.`;
        } catch (err) {
            this.logDebug('[ImplicitEnhancer] injectMiningKnowledge failed', err);
            return '';
        }
    }

    analyzeTaskRequirements(commandString) {
        const bot = this.agent?.bot;
        if (!bot?.inventory) return null;
        if (!commandString) return null;

        const invItems = bot.inventory.items?.() || [];
        const countInInv = (name) => invItems.filter(i => i.name === name).reduce((s, i) => s + i.count, 0);

        // Ensure there is a furnace before smelting
        const smeltMatch = commandString.match(/!smeltItem\(\s*["']([^"']+)["']/i);
        if (smeltMatch) {
            const hasFurnace = countInInv('furnace') > 0;
            let nearbyFurnace = null;
            try {
                nearbyFurnace = bot.findBlock?.({
                    maxDistance: 32,
                    matching: (b) => b?.name === 'furnace'
                });
            } catch (_) { /* ignore findBlock failures */ }

            if (!nearbyFurnace) {
                if (hasFurnace) {
                    return {
                        goal: '放置熔炉后再进行熔炼',
                        command: '!placeHere("furnace")',
                        advice: '附近没有熔炉，但背包里有。先把熔炉放下。'
                    };
                }
                const cobble = countInInv('cobblestone');
                if (cobble < 8) {
                    const need = 8 - cobble;
                    return {
                        goal: `收集圆石以合成熔炉（缺少 ${need} 个）`,
                        command: `!collectBlocks("cobblestone", ${need})`,
                        advice: `没有熔炉也没有足够的圆石来制作熔炉，先补足圆石 ${need} 个。`
                    };
                }
                return {
                    goal: '先合成熔炉，再进行熔炼',
                    command: '!craftRecipe("furnace", 1)',
                    advice: '附近没有熔炉，背包也没有，先合成一个熔炉再 smelt。'
                };
            }
        }

        // Fix misused attack for mining blocks
        const attackMatch = commandString.match(/!attack\(\s*["']([^"']+)["']/i);
        if (attackMatch) {
            const targetName = attackMatch[1]?.toLowerCase();
            const likelyBlock = (() => {
                if (!targetName) return false;
                if (targetName.includes('ore') || targetName.includes('log') || targetName.includes('plank') || targetName.includes('stone') || targetName.includes('cobblestone')) return true;
                if (bot.registry?.blocksByName?.[targetName]) return true;
                return false;
            })();
            if (likelyBlock) {
                return {
                    goal: `Mine ${targetName} (use collection, not attack)`,
                    command: `!collectBlocks("${targetName}", 1)`,
                    advice: 'To gather blocks, use collect/search not attack.'
                };
            }
        }

        // Extract target block from collect/search commands
        const match = commandString.match(/!(?:collectBlocks|searchForBlock)\(\s*["']([^"']+)["']/i);
        if (!match || !match[1]) return null;
        const cmdNameMatch = commandString.match(/!(\w+)/);
        const cmdName = cmdNameMatch ? cmdNameMatch[1] : null;
        if (!bot.registry) return null;
        const target = match[1].toLowerCase();

        // Cobblestone acquisition: mine stone instead of searching cobblestone
        if (target === 'cobblestone') {
            let requested = 1;
            const countMatch = commandString.match(/collectBlocks\(\s*["']cobblestone["']\s*,\s*(\d+)/i);
            if (countMatch && !Number.isNaN(parseInt(countMatch[1]))) {
                requested = parseInt(countMatch[1]);
            }
            return {
                goal: 'Mine stone to obtain cobblestone',
                command: `!collectBlocks("stone", ${requested})`,
                advice: 'Cobblestone comes from mining stone; skip searching cobblestone blocks.'
            };
        }

        // Default wood: prefer acacia_log when target is generic "log"/"wood"/"planks"
        const genericWood = ['log', 'logs', 'wood', 'plank', 'planks', 'wooden_planks'];
        if (genericWood.includes(target)) {
            const replacement = 'acacia_log';
            const defaultCollectCount = 4;
            const cmd = cmdName === 'searchForBlock'
                ? `!searchForBlock("${replacement}", 32)`
                : `!collectBlocks("${replacement}", ${defaultCollectCount})`;
            return {
                goal: 'Default to collecting acacia logs',
                command: cmd,
                advice: 'Wood type not specified; default to acacia_log for collection/search.'
            };
        }

        // If already有铁锭和木棍，避免重复去砍木头，直接提示制作铁斧
        const hasIronAxeMats = countInInv('iron_ingot') >= 3 && countInInv('stick') >= 2;
        const isWoodTask = target.includes('log') || target.includes('plank') || target.includes('wood');
        if (isWoodTask && hasIronAxeMats) {
            return {
                goal: 'Materials ready, craft iron axe directly',
                command: '!craftRecipe("iron_axe", 1)',
                advice: 'You already have 3 iron ingots and enough sticks; craft the iron axe instead of chopping wood.'
            };
        }

        const block = bot.registry.blocksByName?.[target];
        if (!block || !block.harvestTools) return null;

        const toolIds = Object.keys(block.harvestTools);
        if (toolIds.length === 0) return null;

        const itemsById = bot.registry.items;
        const toolNames = toolIds.map(id => itemsById[id]?.name).filter(Boolean);
        const hasTool = invItems.some(i => toolNames.includes(i.name));
        if (hasTool) return null;

        const itemsByName = bot.registry.itemsByName || {};

        for (const toolName of toolNames) {
            const tool = itemsByName[toolName];
            if (!tool) continue;
            const recipes = bot.recipesFor(tool.id) || [];
            for (const recipe of recipes) {
                const requirements = (recipe.delta || [])
                    .filter(d => d.count < 0)
                    .map(d => {
                        const name = itemsById[d.id]?.name;
                        return name ? { name, count: Math.abs(d.count) } : null;
                    })
                    .filter(Boolean);

                if (requirements.length === 0) continue;

                const missing = requirements.filter(r => countInInv(r.name) < r.count);
                if (missing.length === 0) {
                    return {
                        goal: `Craft ${toolName} (required to mine ${target})`,
                        command: `!craftRecipe("${toolName}", 1)`,
                        advice: `You have the materials. Craft ${toolName} now before mining ${target}.`
                    };
                } else {
                    const need = missing[0];
                    const needCount = Math.max(1, need.count - countInInv(need.name));
                    return {
                        goal: `Gather materials to craft ${toolName} (needed for ${target})`,
                        command: `!collectBlocks("${need.name}", ${needCount})`,
                        advice: `Missing ${need.name} x${needCount} to craft ${toolName} for mining ${target}.`
                    };
                }
            }
        }

        return null;
    }

    async improvePrompt(intent, info, systemPrompt, teamTasks = []) {
        let prompt = systemPrompt;
        const intentText = intent?.type || 'GENERAL';
        prompt += `\n\nCurrent Intent: "${intentText}".`;

        // Activate mission for BUILD/CRAFT when not active and plan available
        if (!this.activeMission.isActive && intent && ['BUILD', 'CRAFT'].includes(intent.type) && info && info.length > 0) {
            const primaryExample = info.find(ex => Array.isArray(ex.plan) && ex.plan.length > 0);
            if (primaryExample) {
                this.activeMission = {
                    isActive: true,
                    planName: primaryExample.name || primaryExample.slug || intent.type,
                    steps: primaryExample.plan.map(step => ({
                        ...step,
                        action_cmd: step.action_cmd ? [...step.action_cmd] : [],
                        verify_cmd: step.verify_cmd ? [...step.verify_cmd] : []
                    })),
                    currentStep: 0,
                    failures: 0
                };
                this.logDebug(`[ImplicitEnhancer] Started mission "${this.activeMission.planName}" with ${this.activeMission.steps.length} steps for intent ${intent.type}`);
            }
        }

        // Mission control injection (simple)
        if (this.activeMission.isActive) {
            const { steps, currentStep, planName } = this.activeMission;
            const safeIndex = Math.min(currentStep, Math.max(steps.length - 1, 0));
            const step = steps[safeIndex] || {};
            const goal = step.goal || 'Follow the plan step carefully.';
            let requiredCmd = (step.action_cmd && step.action_cmd.length > 0) ? step.action_cmd[0] : '!inventory';

            let miningHint = '';
            const cmdMatch = requiredCmd.match(/!collectBlocks\(\s*["']([^"']+)["']/i);
            let overrideGoal = null;
            let overrideAdvice = '';
            if (cmdMatch && cmdMatch[1]) {
                miningHint = this.injectMiningKnowledge(cmdMatch[1]);
                const override = this.analyzeTaskRequirements(requiredCmd);
                if (override) {
                    overrideGoal = override.goal;
                    requiredCmd = override.command;
                    overrideAdvice = override.advice || '';
                }
            }

            prompt += `\n\n*** MISSION CONTROL ***\n`;
            prompt += `PLAN: ${planName || 'Mission'}\n`;
            prompt += `STEP: ${Math.min(currentStep + 1, steps.length || 1)} / ${steps.length || 1}\n`;
            prompt += `TASK: ${overrideGoal || goal}\n`;
            prompt += `MANDATORY COMMAND: ${requiredCmd}\n`;
            if (miningHint) {
                prompt += `${miningHint}\n`;
            }
            if (overrideAdvice) {
                prompt += `${overrideAdvice}\n`;
            }
            prompt += `ABSTRACT RULES:\n- BEFORE any action, run !inventory to see current resources. If materials already exist, DO NOT collect more; move to crafting/next step.\n- Before smelting: if no furnace is placed nearby, place your furnace; if you have none, craft one; then smelt.\n- Before executing any action_cmd that mines a block, check whether you have the required tool. If missing, pause the plan and inject a tool-crafting subplan. Never try to mine with the wrong tool.\n- Follow the plan until all steps are done; after completing a step, go to the next one immediately. Do NOT ask the user what to do next unless the plan is fully complete.\n- Craft items instead of searching when they are not natural blocks.\n- Only use !searchForBlock for natural blocks you can find in the world.\n- ALWAYS specify tool material (e.g., stone_pickaxe, iron_pickaxe), never generic "pickaxe".\n- To obtain cobblestone: use a wooden_pickaxe to mine stone to get cobblestone.\n- Narrate briefly, then output the exact command.\n`;
            prompt += `\nOUTPUT FORMAT:\nTHOUGHT: [Reasoning about the current state/plan]\nCOMMAND: !commandName("arg1", arg2)\n`;
            prompt += `\nExample (Dynamic Subplan Injection):\nGoal: Collect Cobblestone\nInventory: no pickaxe\nThought: Cobblestone requires a pickaxe. I need to craft a wooden pickaxe first.\nCommands:\n!collectBlocks("log", 2)\n!craftRecipe("planks", 4)\n!craftRecipe("stick", 2)\n!craftRecipe("wooden_pickaxe", 1)\n`;

            if (teamTasks && teamTasks.length > 0) {
                const teamText = teamTasks.map(t => {
                    const teamIntent = t.intent?.type || 'unknown';
                    return `Agent: ${t.agent} | Status: ${t.status} | Intent: ${teamIntent} | Task: ${t.summary || ''}`;
                }).join('\n');
                prompt += `\nTeam Context:\n${teamText}\n- Coordinate with teammates; avoid duplicating active tasks.\n- If overlap detected, choose a complementary or remaining task instead.`;
            }
            return prompt;
        }

        // No active mission: minimal guidance and command reference
        prompt += this.buildCommandReference();

        if (teamTasks && teamTasks.length > 0) {
            const teamText = teamTasks.map(t => {
                const teamIntent = t.intent?.type || 'unknown';
                return `Agent: ${t.agent} | Status: ${t.status} | Intent: ${teamIntent} | Task: ${t.summary || ''}`;
            }).join('\n');
            prompt += `\n\nTeam Context:\n${teamText}\n- Coordinate with teammates; avoid duplicating active tasks.\n- If overlap detected, choose a complementary or remaining task instead.`;
        }

        prompt += `\n\nABSTRACT RULES:\n- BEFORE any action, run !inventory to see current resources. If materials already exist, DO NOT collect more; move to crafting/next step.\n- Before smelting: if no furnace is placed nearby, place your furnace; if you have none, craft one; then smelt.\n- Before executing any action_cmd that mines a block, check whether you have the required tool. If missing, pause the plan and inject a tool-crafting subplan. Never try to mine with the wrong tool.\n- Follow the plan until all steps are done; after completing a step, go to the next one immediately. Do NOT ask the user what to do next unless the plan is fully complete.\n- Craft items instead of searching when they are not natural blocks.\n- Only use !searchForBlock for natural blocks you can find in the world.\n- ALWAYS specify tool material (e.g., stone_pickaxe, iron_pickaxe), never generic "pickaxe".\n- To obtain cobblestone: use a wooden_pickaxe to mine stone to get cobblestone.\n- Narrate briefly, then output the exact command.\n`;
        prompt += `\nOUTPUT FORMAT:\nTHOUGHT: [Reasoning about the current state/plan]\nCOMMAND: !commandName("arg1", arg2)\n`;
        prompt += `\nExample (Dynamic Subplan Injection):\nGoal: Collect Cobblestone\nInventory: no pickaxe\nThought: Cobblestone requires a pickaxe. I need to craft a wooden pickaxe first.\nCommands:\n!collectBlocks("log", 2)\n!craftRecipe("planks", 4)\n!craftRecipe("stick", 2)\n!craftRecipe("wooden_pickaxe", 1)\n`;
        return prompt;
    }

    async saveRelevantInfo(intent, response) {
        try {
            const memoryPath = join(this.memoryDir, 'memory.json');
            await fs.mkdir(dirname(memoryPath), { recursive: true });

            let memoryData = { memory_bank: {} };
            try {
                const currentMemory = await fs.readFile(memoryPath, 'utf8');
                memoryData = JSON.parse(currentMemory);
            } catch {
                // No existing memory, start fresh
            }

            if (!memoryData || typeof memoryData !== 'object') {
                memoryData = { memory_bank: {} };
            }
            if (!memoryData.memory_bank || typeof memoryData.memory_bank !== 'object') {
                memoryData.memory_bank = {};
            }

            const type = (intent?.type || 'general').toLowerCase();
            const key = `last_${type}_action`;
            memoryData.memory_bank[key] = {
                intent: intent?.subtype || 'unknown',
                result: (response || '').substring(0, 100) + '...',
                timestamp: new Date().toISOString()
            };

            await fs.writeFile(memoryPath, JSON.stringify(memoryData, null, 2));
        } catch (error) {
            const details = error?.stack || error?.message || JSON.stringify(error);
            console.error('[ImplicitEnhancer] Failed to save memory:', details);
        }
    }


    normalizeCommandsInResponse(response) {
        if (!response || typeof response !== 'string') {
            return response;
        }

        if (/!startConversation/i.test(response)) {
            return '';
        }

        const actionMap = new Map();
        actionsList.forEach(a => {
            const key = a.name?.replace(/^!/, '').toLowerCase();
            if (key) actionMap.set(key, a);
        });

        const enforceActionSchema = (cmdName, args) => {
            const def = actionMap.get(cmdName.toLowerCase());
            if (!def || !def.params) return args;

            const expected = Object.entries(def.params);
            const out = [];
            for (let i = 0; i < expected.length; i++) {
                const [paramName, paramDef] = expected[i];
                const type = (paramDef?.type || 'string').toLowerCase();
                const lowerParam = paramName.toLowerCase();
                let provided = args[i];

                const needsNumeric = type === 'int' || type === 'float';
                const isRange = lowerParam.includes('range') || lowerParam.includes('dist');
                const isPlayerLike = lowerParam.includes('player') || lowerParam.includes('mode');

                if (provided === undefined) {
                    if (needsNumeric) {
                        provided = isRange ? '32' : '1';
                    } else if (type === 'boolean') {
                        provided = 'true';
                    } else {
                        provided = '""';
                    }
                } else {
                    if (needsNumeric) {
                        if (!/^[-+]?\d+(\.\d+)?$/.test(provided)) {
                            provided = isRange ? '32' : '1';
                        }
                    } else if (type === 'boolean') {
                        provided = /false/i.test(provided) ? 'false' : 'true';
                    } else {
                        let unquoted = provided.replace(/^['"]|['"]$/g, '');
                        provided = `"${unquoted}"`;
                    }
                }

                out.push(provided);
            }
            return out;
        };

        const regex = /!([a-zA-Z0-9_]+)(?:[ (]*)([^)\n!.?]*)(?:[)]?)/g;
        const normalized = response.replace(regex, (match, cmd, rawArgs) => {
            const rawArgStr = rawArgs || '';
            const tokens = rawArgStr.replace(/,/g, ' ').match(/"[^"]*"|'[^']*'|[^,\s]+/g) || [];
            const preliminary = tokens.map(tok => tok.trim()).filter(Boolean);
            const finalArgs = enforceActionSchema(cmd, preliminary);
            return `!${cmd}(${finalArgs.join(', ')})`;
        });

        if (normalized !== response) {
            this.logDebug(`[ImplicitEnhancer] Commands normalized:\nBefore: ${response.slice(0, 150)}...\nAfter:  ${normalized.slice(0, 150)}...`);
        }

        return normalized;
    }

    async applyTaskOverrides(response) {
        if (!response || typeof response !== 'string') return response;
        const commandMatch = response.match(/![a-zA-Z0-9_]+\([^)]*\)/);
        if (!commandMatch) return response;

        const override = this.analyzeTaskRequirements(commandMatch[0]);
        if (!override) return response;

        const thought = override.advice || override.goal || '调整动作以满足前置条件。';
        const rewritten = `THOUGHT: ${thought}\nCOMMAND: ${override.command}`;
        this.logDebug(`[ImplicitEnhancer] Override applied for command ${commandMatch[0]} -> ${override.command}`);
        return rewritten;
    }
}
