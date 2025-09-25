import { join } from 'path';
import { readFileSync } from 'fs';
import { Enhancer } from './enhancer.js';  
import { Local } from '../local.js';
import { Doubao } from '../doubao.js';

// 意图到训练数据文件的映射
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
            throw new Error("ImplicitEnhancer requires an Enhancer instance in config");
        }

        this.agent = config.agent;

        // 将 JSON 配置实例化为模型对象
        let modelInstance = null;
        const modelConfig = config.enhancer.model;

        switch(modelConfig.api) {
            case 'ollama':
                modelInstance = new Local(modelConfig.model, modelConfig.url);
                break;
            case 'doubao':
                modelInstance = new Doubao(modelConfig.model, modelConfig.url); // ← 这里new出你的Doubao类
                break;
            default:
                throw new Error(`Unsupported model API: ${modelConfig.api}`);
        }

        // 传给 Enhancer
        const enhancerConfig = { ...config.enhancer, model: modelInstance };
        this.innerEnhancer = new Enhancer(enhancerConfig);
        this.trainingDir = join(process.cwd(), 'data', 'training');
    }

    async getRelevantTrainingFiles(intent) {
        if (!intent) return [];
        const relevantFiles = new Set();

        const mainIntentFile = INTENT_TO_TRAINING_FILE[intent.type] || INTENT_TO_TRAINING_FILE.DEFAULT;
        relevantFiles.add(join(this.trainingDir, mainIntentFile));

        if (intent.subtype === 'RESOURCE_GATHERING') {
            relevantFiles.add(join(this.trainingDir, INTENT_TO_TRAINING_FILE.COLLECT));
        }

        switch(intent.type) {
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

    async sendRequest(model, turns, systemPrompt, stop_seq='***') {
        const intent = await this.getIntent(turns, systemPrompt);
        const info = await this.getRelevantInfo(intent);
        const prompt = await this.improvePrompt(intent, info, systemPrompt);

                // ===== 调试日志 =====
        console.log('--- [ImplicitEnhancer Debug] ---');
        console.log('Intent:', intent);
        console.log('Relevant Info Examples:', info.slice(0,5)); // 只打印前5条避免太长
        console.log('Final Prompt Sent to Model:\n', prompt);
        console.log('-------------------------------');

        const res = await this.innerEnhancer.sendRequest(model, turns.slice(-3), prompt, stop_seq);
        await this.saveRelevantInfo(intent, res);
        return res;
    }

    async getIntent(turns, systemPrompt) {
        if (!turns || turns.length === 0) return null;

        // 从后往前找最近的 user 消息
        const lastUserMessage = [...turns].reverse().find(msg => msg.role === 'user' && msg.content?.trim().length > 0);
        if (!lastUserMessage) return null;

        const userInput = lastUserMessage.content;

        let intentAnalysis;
        try {
            intentAnalysis = await this.determineIntentType(userInput);
        } catch (err) {
            console.warn("Intent analysis failed:", err);
            intentAnalysis = { type: "GENERAL", subtype: "unknown" };
        }

        return {
            id: `intent_${Date.now()}`,
            source: 'user',
            input: userInput,
            type: intentAnalysis.type,
            subtype: intentAnalysis.subtype,
        };
    }

    async determineIntentType(input) {
        const analysisPrompt = {
            role: "system",
            content: `You are an intent analyzer for a Minecraft AI agent. Analyze the given input and determine the user's intent.
Categorize the intent into one of these types: BUILD, CRAFT, COOK, COLLECT, COMBAT, EXPLORE, INTERACT, GENERAL.
Provide JSON with fields: type, subtype. Only return JSON.`
        };

        const userMessage = { role: "user", content: input };

        try {
            const analysis = await this.innerEnhancer.sendRequest(null, [userMessage], analysisPrompt.content, "***");
            const result = JSON.parse(analysis);
            return { type: result.type, subtype: result.subtype };
        } catch (error) {
            console.warn("Intent analysis failed:", error);
            return { type: "GENERAL", subtype: "unknown" };
        }
    }

    async getRelevantInfo(intent) {
        if (!intent) return [];

        const relevantFiles = await this.getRelevantTrainingFiles(intent);
        let allExamples = [];

        for (const filePath of relevantFiles) {
            try {
                const trainingData = JSON.parse(readFileSync(filePath, 'utf8'));
                // const examples = trainingData.map((ex, i) => ({
                //     ...ex,
                //     id: `${filePath}_${i}`,
                //     source_file: filePath
                // }));
                // allExamples = allExamples.concat(examples);
                if (trainingData.length > 0) {
                    const firstExample = {
                        ...trainingData[0],
                        id: `${filePath}_0`,
                        source_file: filePath
                    };
                    allExamples.push(firstExample);
                }
            } catch (err) {
                console.warn(`Failed to load training data from ${filePath}:`, err);
            }
        }
        return allExamples;

    }

    async improvePrompt(intent, info, systemPrompt) {
        let prompt = systemPrompt;

        const intentText = intent?.type || "GENERAL";
        prompt += `You are an AI assistant. The current intent is: "${intentText}".`;

        const guidanceRules = [
            "Always verify the current state before acting (e.g., use !inventory, !stats).",
            "If resources are missing, plan how to obtain them (mine, smelt, craft).",
            "When multiple options exist, ask collaborators which to prioritize.",
            "Coordinate with other bots by sharing and requesting resources.",
            "Once a decision is clear, execute the command immediately."
        ];

        prompt += "\n\nBehavior Guidelines:\n" + guidanceRules.map((r, i) => `${i+1}. ${r}`).join("\n");

        // if (info && info.length > 0) {
        //     const exampleTexts = info.slice(0,5).map(e => `- ${e.input || e.description || e.text}`).join("\n");
        //     prompt += `\n\nRelevant Examples:\n${exampleTexts}`;
        // }

        return prompt;
    }

    async saveRelevantInfo(intent, info) {
        // 以后实现存储
    } 
}
