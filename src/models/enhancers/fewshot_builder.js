/**
 * Few-shot 提示构建器
 * 让 LLM 从示例中学习泛化规律
 *
 * 主要功能：
 * 1. 构建 Few-shot 示例部分
 * 2. 从示例中提取泛化指导
 * 3. 生成变体示例（不依赖 templates.json）
 */
export class FewShotBuilder {
    constructor(debug = false) {
        this.debug = debug;
    }

    /**
     * 构建 Few-shot 示例部分
     *
     * @param {Array} examples - 训练示例数组
     * @param {object} userKeywords - 从用户输入提取的关键字（可选）
     * @returns {string} Few-shot 提示文本
     */
    buildExamplesSection(examples, userKeywords = null) {
        if (!examples || examples.length === 0) return '';

        let text = '\n## FEW-SHOT LEARNING EXAMPLES\n\n';

        if (userKeywords) {
            text += `用户请求分析: ${userKeywords.raw}\n`;
            text += `- 目标: ${userKeywords.target || '未知'}\n`;
            text += `- 材料: ${userKeywords.material || '未指定'}\n`;
            text += `- 工具: ${userKeywords.tool || '未指定'}\n\n`;
        }

        text += '研究这些示例，理解制作工具的 **思路和结构**（不要复制具体值）：\n\n';

        for (let i = 0; i < examples.length; i++) {
            const ex = examples[i];
            text += `### 示例 ${i + 1}: ${ex.name}\n`;
            text += `**任务**：${ex.rationale || ex.actual || ''}\n\n`;

            if (ex.plan && ex.plan.length > 0) {
                text += `**步骤结构**：\n`;
                for (const step of ex.plan) {
                    text += `  ${step.step}. ${step.goal}\n`;
                    if (step.preconditions?.length > 0) {
                        text += `     前置条件：${step.preconditions.join(', ')}\n`;
                    }
                    if (step.action_cmd?.length > 0) {
                        text += `     参考命令：${step.action_cmd[0]} (需根据用户请求替换关键字)\n`;
                    }
                }
            }
            text += '\n';
        }

        return text;
    }

    /**
     * 构建泛化指导部分
     * 直接从训练数据中提取规律，不依赖 templates.json
     *
     * @param {Array} examples - 训练示例数组
     * @param {object} templates - 模板对象（可选，暂时不用）
     * @returns {string} 泛化指导文本
     */
    buildGeneralizationGuide(examples, templates = null) {
        let text = '\n## GENERALIZATION GUIDE\n\n';
        text += '从上面的示例中学习这些规律：\n\n';

        // 提取材料类型
        const materials = new Set();
        const tools = new Set();
        const materialCounts = {}; // 记录每个工具需要的材料数量

        for (const ex of examples) {
            const lower = `${ex.name} ${ex.rationale || ''} ${ex.actual || ''}`.toLowerCase();

            // 提取材料类型
            ['wood', 'stone', 'iron', 'gold', 'diamond', 'netherite'].forEach(m => {
                if (lower.includes(m)) materials.add(m);
            });

            // 提取工具类型
            ['axe', 'pickaxe', 'shovel', 'hoe', 'sword', 'helmet', 'chestplate', 'leggings', 'boots'].forEach(t => {
                if (lower.includes(t)) tools.add(t);
            });

            // 从 action_cmd 中提取材料数量
            if (ex.plan) {
                for (const step of ex.plan) {
                    if (step.action_cmd && step.action_cmd.length > 0) {
                        // 匹配 collectBlocks('xxx_ore', count) 提取材料数量
                        const collectMatch = step.action_cmd.find(cmd =>
                            cmd.includes && cmd.match(/collectBlocks\('(\w+)_ore',\s*(\d+)\)/)
                        );
                        if (collectMatch) {
                            const material = collectMatch[1];
                            const count = parseInt(collectMatch[2]);
                            // 查找对应的工具名称
                            const toolMatch = ex.name.match(/(\w+)$/);
                            if (toolMatch) {
                                const tool = toolMatch[1];
                                if (!materialCounts[tool]) {
                                    materialCounts[tool] = { material: [], count: 0 };
                                }
                                materialCounts[tool].material.push(material);
                                materialCounts[tool].count = count;
                            }
                        }
                    }
                }
            }
        }

        // 材料替换规律
        text += '### 材料替换规律\n';
        if (materials.size > 0) {
            text += `发现的材料：${Array.from(materials).join(', ')}\n`;
            text += `- 不同材料可以互换，保持相同结构\n`;
            text += `- 例如：iron_axe → diamond_axe（只需替换材料）\n`;
            text += `- 注意：某些材料需要熔炼（iron_ore → iron_ingot）\n\n`;
        }

        // 工具类型规律
        text += '### 工具类型规律\n';
        if (tools.size > 0) {
            text += `发现的工具：${Array.from(tools).join(', ')}\n`;
            text += `- 大多数工具需要：材料 + 木棍\n`;

            // 显示从示例中学习到的材料数量
            if (Object.keys(materialCounts).length > 0) {
                text += `- 从示例中学习到的材料数量：\n`;
                for (const [tool, info] of Object.entries(materialCounts)) {
                    const materials = info.material.join(' 或 ');
                    text += `  - ${tool}: ${info.count} 个 ${materials}\n`;
                }
            }
            text += '\n';
        }

        // 步骤规律
        text += '### 通用步骤规律\n';
        text += '1. 检查库存，确认已有材料\n';
        text += '2. 收集缺失的原材料（木棍、矿石等）\n';
        text += '3. 如果需要，熔炼矿石\n';
        text += '4. 合成最终物品\n';
        text += '5. 验证物品是否获得\n\n';

        text += '### 如何应用这些规律\n';
        text += '1. 识别目标物品的材料和工具类型\n';
        text += '2. 参考相似示例的步骤结构\n';
        text += '3. 替换材料/工具值，保持结构不变\n';
        text += '4. 执行前检查前置条件\n';
        text += '5. 如果前置条件不满足，先收集/制作缺失物品\n\n';

        return text;
    }

    /**
     * 生成变体示例（不依赖 templates.json）
     * 直接从训练数据中生成变体
     *
     * @param {object} example - 主示例
     * @param {number} count - 要生成的变体数量
     * @returns {Array} 变体列表
     */
    generateVariantsFromExample(example, count = 2) {
        const variants = [];

        // 从示例名称中提取材料和工具
        // 支持多种格式: "Craft an Iron Axe", "Iron Axe", "Craft a Diamond Pickaxe"
        let material = null;
        let tool = null;

        // 首先尝试从 slug 中提取（格式如 "crafting/iron_axe"）
        const slugMatch = example.slug?.match(/(\w+)_(\w+)$/);
        if (slugMatch) {
            material = slugMatch[1].toLowerCase();
            tool = slugMatch[2].toLowerCase();
        }

        // 如果 slug 失败，尝试从名称中提取
        if (!material || !tool) {
            // 移除 "Craft", "an", "a" 等词
            const cleanName = example.name.replace(/^(Craft|Make|Build)\s+(an?\s+)?/i, '');
            const words = cleanName.split(/\s+/);

            // 材料通常是第一个词
            const materials = ['wood', 'stone', 'iron', 'gold', 'diamond', 'netherite'];
            const tools = ['axe', 'pickaxe', 'shovel', 'hoe', 'sword', 'helmet', 'chestplate', 'leggings', 'boots'];

            for (const word of words) {
                const lower = word.toLowerCase();
                if (materials.includes(lower) && !material) {
                    material = lower;
                } else if (tools.includes(lower)) {
                    tool = lower;
                }
            }
        }

        if (!material || !tool) return variants;

        // 定义替换映射
        const materialReplacements = {
            'iron': 'diamond',
            'diamond': 'stone',
            'stone': 'wood'
        };

        const toolReplacements = {
            'axe': 'pickaxe',
            'pickaxe': 'shovel',
            'shovel': 'sword'
        };

        // 生成变体
        let i = 0;
        for (const [origMaterial, newMaterial] of Object.entries(materialReplacements)) {
            if (origMaterial === material) {
                const newTool = toolReplacements[tool] || tool;

                variants.push({
                    isVariant: true,
                    name: `Craft ${newMaterial.charAt(0).toUpperCase() + newMaterial.slice(1)} ${newTool}`,
                    description: `变体：将 ${material} 替换为 ${newMaterial}，${tool} 替换为 ${newTool}`,
                    from: `${material}_${tool}`,
                    to: `${newMaterial}_${newTool}`
                });

                i++;
                if (i >= count) break;
            }
        }

        return variants;
    }

    logDebug(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }

    /**
     * 构建关键字替换指导
     *
     * @param {object} userKeywords - 从用户输入提取的关键字
     * @param {object} selectedExample - 选中的训练示例
     * @returns {string} 关键字替换指导文本
     */
    buildKeywordSubstitutionGuide(userKeywords, selectedExample) {
        let text = '\n## KEYWORD SUBSTITUTION GUIDE\n\n';

        const exampleKeywords = this.extractExampleKeywords(selectedExample);

        text += '用户请求：\n';
        text += `- 材料: ${userKeywords.material || '未指定'}\n`;
        text += `- 工具: ${userKeywords.tool || '未指定'}\n`;
        text += `- 目标: ${userKeywords.target || '未指定'}\n\n`;

        text += '示例中的值：\n';
        text += `- 材料: ${exampleKeywords.material || '未指定'}\n`;
        text += `- 工具: ${exampleKeywords.tool || '未指定'}\n`;
        text += `- 目标: ${exampleKeywords.target || '未指定'}\n\n`;

        text += '### 替换规则\n';
        text += '1. 学习示例的 **步骤结构** 和 **思路**\n';
        text += '2. 在执行命令时，替换以下关键字：\n';

        if (userKeywords.material && exampleKeywords.material && userKeywords.material !== exampleKeywords.material) {
            text += `   - 将 "${exampleKeywords.material}" 替换为 "${userKeywords.material}"\n`;
        }

        if (userKeywords.tool && exampleKeywords.tool && userKeywords.tool !== exampleKeywords.tool) {
            text += `   - 将 "${exampleKeywords.tool}" 替换为 "${userKeywords.tool}"\n`;
        }

        if (userKeywords.target && exampleKeywords.target && userKeywords.target !== exampleKeywords.target) {
            text += `   - 将 "${exampleKeywords.target}" 替换为 "${userKeywords.target}"\n`;
        }

        text += '\n### 示例\n';
        text += `如果示例是：!craftRecipe("${exampleKeywords.target || 'stone_sword'}", 1)\n`;
        text += `你应该生成：!craftRecipe("${userKeywords.target || 'iron_axe'}", 1)\n\n`;

        text += '### 重要提醒\n';
        text += '- 保持步骤结构不变\n';
        text += '- 只替换材料、工具、目标名称\n';
        text += '- 不要复制示例中的具体值\n';

        return text;
    }

    /**
     * 从示例中提取关键字
     *
     * @param {object} example - 训练示例对象
     * @returns {object} { material, tool, target }
     */
    extractExampleKeywords(example) {
        const text = `${example.name} ${example.rationale || ''} ${example.slug || ''}`.toLowerCase();

        const materials = ['wood', 'stone', 'iron', 'gold', 'diamond', 'netherite'];
        const tools = ['axe', 'pickaxe', 'shovel', 'hoe', 'sword'];

        let material = null;
        let tool = null;

        for (const m of materials) {
            if (text.includes(m)) {
                material = m;
                break;
            }
        }

        for (const t of tools) {
            if (text.includes(t)) {
                tool = t;
                break;
            }
        }

        return {
            material,
            tool,
            target: material && tool ? `${material}_${tool}` : (tool || material)
        };
    }
}
