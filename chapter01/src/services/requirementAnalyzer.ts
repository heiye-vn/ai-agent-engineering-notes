import { LLMClient } from "../llm/client";

import {
  REQUIREMENT_ANALYSIS_SYSTEM_PROMPT,
  buildRequirementAnalysisPrompt,
} from "../llm/prompts";

import type { RequirementAnalysis } from "../llm/schemas";
import { isRequirementAnalysis } from "../llm/validators";
import { withRetry } from "../llm/utils";

export class RequirementAnalyzer {
  private llm: LLMClient;

  constructor(model = "qwen3.7-flash") {
    this.llm = new LLMClient(model);
  }

  async analyze(requirement: string): Promise<RequirementAnalysis> {
    const userPrompt = buildRequirementAnalysisPrompt(requirement);

    // 增加重试机制
    return withRetry(async () => {
      const result = await this.llm.generateJSON<unknown>(
        REQUIREMENT_ANALYSIS_SYSTEM_PROMPT,
        userPrompt,
      );

      // 校验输出数据格式
      if (!isRequirementAnalysis(result)) {
        throw new Error(`模型输出不是合法 RequirementAnalysis：${result}`);
      }

      return result;
    });
  }
}
