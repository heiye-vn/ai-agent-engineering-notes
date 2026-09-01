export const REQUIREMENT_ANALYSIS_SYSTEM_PROMPT = `
你是一名需求分析助手。
  你必须严格按 JSON 返回。
  如果信息不足，不要猜测，而是在 questions 字段中提出。
  不要输出额外解释。
`.trim();

export function buildRequirementAnalysisPrompt(requirement: string): string {
  return `
        请分析以下需求，并 输出结构化结果。

        需求：${requirement}

        返回字段要求：
        1. summary: 需求摘要
        2. modules: 模块列表，每个元素包含 name 和 responsibility
        3. risks: 风险列表
        4. questions: 待确认问题列表
    `.trim();
}
