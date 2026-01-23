/**
 * 关键字提取器
 * 从用户输入中提取：材料、工具、动作、数量
 *
 * 主要功能：
 * 1. 从用户输入中提取材料 (wood, stone, iron, etc.)
 * 2. 从用户输入中提取工具类型 (axe, pickaxe, sword, etc.)
 * 3. 从用户输入中提取动作 (craft, collect, smelt, etc.)
 * 4. 构建组合目标 (iron_axe, diamond_pickaxe, etc.)
 */
export class KeywordExtractor {
    constructor(debug = false) {
        this.debug = debug;

        // 材料类型
        this.materials = [
            'wood', 'stone', 'iron', 'gold', 'diamond', 'netherite',
            'oak', 'birch', 'spruce', 'acacia', 'jungle', 'dark_oak'
        ];

        // 工具类型（按优先级排序，长名称在前）
        this.tools = [
            'pickaxe', 'chestplate', 'leggings',
            'axe', 'shovel', 'hoe', 'sword',
            'helmet', 'boots'
        ];

        // 动作类型
        this.actions = {
            craft: ['craft', 'make', 'build', 'create', 'crafting'],
            collect: ['collect', 'gather', 'mine', 'chop', 'harvest'],
            smelt: ['smelt', 'melt', 'cook', 'furnace']
        };
    }

    /**
     * 从用户输入中提取关键字
     *
     * @param {string} userInput - 用户输入
     * @returns {object} { material, tool, action, target, raw }
     */
    extract(userInput) {
        const lower = userInput.toLowerCase();

        const result = {
            material: null,
            tool: null,
            action: null,
            target: null,  // 组合目标，如 "iron_axe"
            raw: userInput
        };

        // 提取动作
        for (const [action, keywords] of Object.entries(this.actions)) {
            if (keywords.some(kw => lower.includes(kw))) {
                result.action = action;
                break;
            }
        }

        // 提取材料（按优先级顺序：稀有材料优先）
        for (const material of ['netherite', 'diamond', 'gold', 'iron', 'stone', 'wood']) {
            if (lower.includes(material)) {
                result.material = material;
                break;
            }
        }

        // 提取工具类型
        for (const tool of this.tools) {
            if (lower.includes(tool)) {
                result.tool = tool;
                break;
            }
        }

        // 构建目标
        if (result.material && result.tool) {
            result.target = `${result.material}_${result.tool}`;
        } else if (result.tool) {
            result.target = result.tool;
        } else if (result.material) {
            result.target = result.material;
        }

        this.logDebug('[KeywordExtractor]', result);
        return result;
    }

    /**
     * 从示例中提取关键字（用于对比）
     *
     * @param {object} example - 训练示例对象
     * @returns {object} { material, tool, action, target, raw }
     */
    extractFromExample(example) {
        const text = `${example.name} ${example.rationale || ''} ${example.actual || ''}`.toLowerCase();
        return this.extract(text);
    }

    logDebug(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }
}
