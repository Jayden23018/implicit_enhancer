/**
 * 物品名称规范化器
 * 针对弱模型（如千问8b）的物品名称模糊问题进行修正
 *
 * 主要功能：
 * 1. 日常用语映射（如 "木头" → "oak_log"）
 * 2. 模糊物品规范（如 "log" → "oak_log"）
 * 3. 环境感知选择（优先使用附近的资源）
 */
export class ItemNormalizer {
    constructor(debug = false) {
        this.debug = debug;

        // 日常用语 → MC 术语映射
        this.colloquialMap = {
            '木头': 'log',
            '原木': 'oak_log',
            '木板': 'planks',
            '石头': 'cobblestone',
            '煤炭': 'coal',
            '煤块': 'coal_block',
            '铁矿': 'iron_ore',
            '金矿': 'gold_ore',
            '钻石矿': 'diamond_ore',
            '木棍': 'stick',
            '棍子': 'stick',
            '工作台': 'crafting_table',
            '熔炉': 'furnace',
            '箱子': 'chest'
        };

        // 模糊物品名 → 具体物品映射列表
        this.genericToSpecific = {
            'log': ['oak_log', 'birch_log', 'spruce_log', 'acacia_log', 'dark_oak_log', 'jungle_log'],
            'plank': ['oak_plank', 'birch_plank', 'spruce_plank', 'acacia_plank', 'dark_oak_plank', 'jungle_plank'],
            'ore': ['iron_ore', 'coal_ore', 'gold_ore', 'diamond_ore', 'copper_ore'],
            'wood': ['oak_log', 'birch_log', 'spruce_log']
        };

        // 物品类别 → 默认选择
        this.defaultChoices = {
            'log': 'oak_log',
            'plank': 'oak_plank',
            'wood': 'oak_log',
            'stone': 'cobblestone',
            'coal': 'coal'
        };
    }

    /**
     * 规范化物品名称
     * 处理流程：
     * 1. 检查是否为日常用语
     * 2. 检查是否为模糊名称
     * 3. 检查是否在 MC 注册表中
     * 4. 尝试部分匹配
     *
     * @param {string} itemName - 输入的物品名称
     * @param {object} bot - Mineflayer bot 实例
     * @returns {string} 规范化后的物品名称
     */
    normalize(itemName, bot) {
        if (!itemName) return null;

        const lower = itemName.toLowerCase().trim();

        // 步骤1：检查日常用语映射
        if (this.colloquialMap[lower]) {
            const mapped = this.colloquialMap[lower];
            this.logDebug(`[ItemNormalizer] 日常用语映射: "${itemName}" → "${mapped}"`);
            return mapped;
        }

        // 步骤2：检查是否为模糊名称（如 "log", "plank"）
        for (const [generic, specifics] of Object.entries(this.genericToSpecific)) {
            if (lower === generic) {
                const defaultItem = this.defaultChoices[generic];
                this.logDebug(`[ItemNormalizer] 模糊名称: "${itemName}" → "${defaultItem}"`);
                return defaultItem;
            }
        }

        // 步骤3：检查是否在 MC 注册表中
        if (bot?.registry?.itemsByName?.[lower]) {
            return lower;
        }

        // 步骤4：部分匹配（如 "iron" → "iron_ingot"）
        if (bot?.registry?.itemsByName) {
            for (const [mcName, mcItem] of Object.entries(bot.registry.itemsByName)) {
                if (mcName.includes(lower) || lower.includes(mcName.split('_')[0])) {
                    this.logDebug(`[ItemNormalizer] 部分匹配: "${itemName}" → "${mcName}"`);
                    return mcName;
                }
            }
        }

        this.logDebug(`[ItemNormalizer] 无法规范化: "${itemName}"`);
        return itemName; // 返回原值，让后续流程处理
    }

    /**
     * 智能选择最佳物品变体
     * 优先选择附近可用的物品
     *
     * @param {string} itemName - 输入的物品名称
     * @param {object} bot - Mineflayer bot 实例
     * @param {object} options - 选项 { searchRange: 32 }
     * @returns {string} 最佳物品变体
     */
    selectBestVariant(itemName, bot, options = {}) {
        const { searchRange = 32 } = options;

        // 先规范化
        const normalized = this.normalize(itemName, bot);

        // 检查是否有多个变体
        const variants = this.genericToSpecific[normalized] || [];
        if (variants.length === 0) {
            return normalized; // 没有变体，直接返回
        }

        // 检查附近有哪些变体可用
        const nearby = this.scanNearbyBlocks(bot, variants, searchRange);

        if (nearby.length > 0) {
            // 返回最近的变体
            const best = nearby[0].type;
            this.logDebug(`[ItemNormalizer] 附近有 ${nearby.length} 个变体，选择: "${best}" (距离: ${nearby[0].distance.toFixed(1)})`);
            return best;
        }

        // 没有找到附近的，返回默认值
        const defaultItem = this.defaultChoices[normalized] || variants[0];
        this.logDebug(`[ItemNormalizer] 附近没有找到，使用默认: "${defaultItem}"`);
        return defaultItem;
    }

    /**
     * 扫描附近的方块
     *
     * @param {object} bot - Mineflayer bot 实例
     * @param {string[]} blockTypes - 要搜索的方块类型列表
     * @param {number} range - 搜索范围
     * @returns {Array} 附近的方块列表，按距离排序
     */
    scanNearbyBlocks(bot, blockTypes, range = 32) {
        const nearby = [];

        if (!bot?.findBlock) return nearby;

        for (const blockType of blockTypes) {
            try {
                const block = bot.findBlock({
                    maxDistance: range,
                    matching: (b) => b?.name === blockType
                });

                if (block) {
                    const dist = bot.entity.position.distanceTo(block.position);
                    nearby.push({ type: blockType, distance: dist, block });
                }
            } catch (err) {
                // 忽略查找错误
            }
        }

        // 按距离排序
        nearby.sort((a, b) => a.distance - b.distance);
        return nearby;
    }

    /**
     * 生成物品选择建议
     * 用于提示 LLM 做出更好的选择
     *
     * @param {string} prompt - 提示文本
     * @returns {Array} 建议列表
     */
    generateItemSuggestion(prompt) {
        const suggestions = [];

        // 检测提示中的模糊物品
        for (const generic of Object.keys(this.genericToSpecific)) {
            if (prompt.toLowerCase().includes(generic)) {
                const variants = this.genericToSpecific[generic];
                const defaultItem = this.defaultChoices[generic];

                suggestions.push({
                    generic: generic,
                    variants: variants,
                    default: defaultItem,
                    advice: `检测到 "${generic}" 是模糊名称。MC 中需要指定具体类型，如 "${variants[0]}"。默认推荐: "${defaultItem}"`
                });
            }
        }

        return suggestions;
    }

    logDebug(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }
}
