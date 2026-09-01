import OpenAI from "openai";
import "dotenv/config";

const client = new OpenAI({
  apiKey: process.env.BAILIAN_API_KEY,
  baseURL: process.env.BAILIAN_BASE_URL,
});

interface RequirementAnalysis {
  summary: string;
  modules: string[];
  risks: string[];
  priority: "low" | "medium" | "high" | "urgent";
  questions: string[];
}

function isRequirementAnalysis(data: unknown): data is RequirementAnalysis {
  if (typeof data !== "object" || data === null) return false;

  const obj = data as Record<string, unknown>;

  return (
    typeof obj.summary === "string" &&
    Array.isArray(obj.modules) &&
    Array.isArray(obj.risks) &&
    ["low", "medium", "high", "urgent"].includes(String(obj.priority)) &&
    Array.isArray(obj.questions)
  );
}

async function analyzeRequirementAsJSON() {
  const response = await client.responses.create({
    model: "qwen3.8-max",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "你是一名需求分析助手。你必须严格按 JSON 格式返回。不要输出额外解释。如果信息不足，请不要猜测，而是在 questions 字段中提出。".trim(),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
请分析下面这个需求，并按 JSON 返回，字段必须包括：
- summary: string
- modules: string[]
- risks: string[]
- priority: "low" | "medium" | "high" | "urgent"
- questions: string[]

需求：
运营同学每天会上传一份 Excel 文件，系统需要自动解析其中的数据，并生成一份日报。日报生成后支持导出，如果文件字段缺失或格式异常，需要给出明确提示。
            `.trim(),
          },
        ],
      },
    ],
  });

  const data = JSON.parse(response.output_text);

  if (!isRequirementAnalysis(data)) {
    throw new Error("非 RequirementAnalysis 格式数据");
  }

  console.log(data);
}

analyzeRequirementAsJSON().catch(console.error);
