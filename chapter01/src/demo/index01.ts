import OpenAI from "openai";
import "dotenv/config";

/**
 * 需求描述：运营同学每天会上传一份 Excel 文件，系统需要自动解析其中的数据，并生成一份日报。
 * 日报生成后支持导出，如果文件字段缺失或格式异常，需要给出明确提示。
 */

const client = new OpenAI({
  apiKey: process.env.BAILIAN_API_KEY,
  baseURL: process.env.BAILIAN_BASE_URL,
});

// 自然语言输出摘要
async function summarizeRequirement() {
  const response = await client.responses.create({
    model: "qwen3.8-max",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "你是一名产品技术分析助手，擅长将业务需求拆解为功能目标、核心模块和潜在风险。请使用简洁、清晰的中文输出。",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
请分析下面这个需求，并按以下三部分输出：
1. 功能目标
2. 核心模块
3. 风险点

需求：
运营同学每天会上传一份 Excel 文件，系统需要自动解析其中的数据，并生成一份日报。日报生成后支持导出，如果文件字段缺失或格式异常，需要给出明确提示。
            `.trim(),
          },
        ],
      },
    ],
  });

  console.log(response.output_text);
}

summarizeRequirement().catch(console.error);
