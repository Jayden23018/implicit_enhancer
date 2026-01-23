/**
 * 前置条件提取器
 * 从训练数据中提取和使用前置条件，替代硬编码的前置条件检查逻辑
 *
 * 主要功能：
 * 1. 从训练数据的 plan 步骤中提取 preconditions
 * 2. 将 preconditions 格式化为 LLM 提示
 * 3. 验证 preconditions 是否被满足
 */
export class PreconditionExtractor {
    constructor(debug = false) {
        this.debug = debug;
    }

    /**
     * 从示例中提取所有前置条件
     *
     * @param {Array} examples - 训练示例数组
     * @returns {Array} 前置条件列表
     */
    extractPreconditions(examples) {
        const preconditions = [];

        for (const example of examples) {
            if (!example.plan) continue;

            for (const step of example.plan) {
                if (!step.preconditions || step.preconditions.length === 0) continue;

                preconditions.push({
                    exampleName: example.name,
                    step: step.step,
                    goal: step.goal,
                    preconditions: step.preconditions,
                    actionCmd: step.action_cmd?.[0] || null
                });
            }
        }

        return preconditions;
    }

    /**
     * 将前置条件格式化为 LLM 提示
     *
     * @param {Array} preconditions - 前置条件列表
     * @returns {string} 格式化后的提示文本
     */
    formatForPrompt(preconditions) {
        if (preconditions.length === 0) return '';

        let text = '\n## PRECONDITIONS FROM TRAINING DATA\n\n';
        text += '参考相似任务的前置条件检查：\n\n';

        for (const prec of preconditions) {
            text += `**步骤 ${prec.step}: ${prec.goal}**\n`;
            text += `需要满足的条件：\n`;
            for (const cond of prec.preconditions) {
                text += `  - ${cond}\n`;
            }
            if (prec.actionCmd) {
                text += `执行命令：${prec.actionCmd}\n`;
            }
            text += '\n';
        }

        text += `**学习要点**：\n`;
        text += `- 注意每个动作前需要检查什么条件\n`;
        text += `- 如果材料缺失，先收集/制作，再执行下一步\n`;
        text += `- 如果工具缺失，先制作工具\n`;
        text += `- 如果条件不满足，不要执行动作，先满足前置条件\n\n`;

        return text;
    }

    /**
     * 简单的前置条件验证（基于模式匹配）
     *
     * @param {Array} preconditions - 前置条件列表
     * @param {object} inventory - 库存对象 { items: [...] }
     * @param {object} bot - Mineflayer bot 实例（可选）
     * @returns {Array} 缺失的前置条件列表
     */
    validatePreconditions(preconditions, inventory, bot) {
        const missing = [];

        for (const cond of preconditions) {
            const lower = cond.toLowerCase();

            // 检查物品数量：如 "3x Iron Ingot"
            const itemMatch = lower.match(/(\d+)x?\s*(.+)/);
            if (itemMatch) {
                const [, count, itemName] = itemMatch;
                // 将 "Iron Ingot" 转换为 "iron_ingot" 格式
                const normalizedName = itemName.toLowerCase().replace(/\s+/g, '_');

                const hasItem = inventory.items?.some(i =>
                    i.name === normalizedName && i.count >= parseInt(count)
                );
                if (!hasItem) {
                    missing.push({
                        type: 'item',
                        name: itemName,
                        count: parseInt(count)
                    });
                }
            }

            // 检查工具：如 "Stone Pickaxe in inventory"
            const toolMatch = lower.match(/(pickaxe|axe|shovel|sword|hoe)/i);
            if (toolMatch && lower.includes('in inventory')) {
                const toolType = toolMatch[1];
                const hasTool = inventory.items?.some(i => i.name.includes(toolType));
                if (!hasTool) {
                    missing.push({ type: 'tool', name: toolType });
                }
            }

            // 检查熔炉
            if (lower.includes('furnace')) {
                const hasFurnace = inventory.items?.some(i => i.name === 'furnace');
                let nearbyFurnace = null;
                if (bot) {
                    try {
                        nearbyFurnace = bot.findBlock?.({
                            maxDistance: 32,
                            matching: (b) => b?.name === 'furnace'
                        });
                    } catch (e) {
                        // ignore
                    }
                }

                if (!hasFurnace && !nearbyFurnace) {
                    missing.push({ type: 'item', name: 'furnace', count: 1 });
                }
            }

            // 检查工作台
            if (lower.includes('crafting table') || lower.includes('crafting_table')) {
                const hasCraftingTable = inventory.items?.some(i => i.name === 'crafting_table');
                let nearbyCraftingTable = null;
                if (bot) {
                    try {
                        nearbyCraftingTable = bot.findBlock?.({
                            maxDistance: 32,
                            matching: (b) => b?.name === 'crafting_table'
                        });
                    } catch (e) {
                        // ignore
                    }
                }

                if (!hasCraftingTable && !nearbyCraftingTable) {
                    missing.push({ type: 'item', name: 'crafting_table', count: 1 });
                }
            }
        }

        return missing;
    }

    logDebug(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }
}
