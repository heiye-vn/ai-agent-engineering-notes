import OpenAI from "openai";
import "dotenv/config";

export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(model = "gpt-5.4") {
    this.client = new OpenAI({
      //   apiKey: process.env.AMUX_API_KEY,
      //   baseURL: process.env.AMUX_BASE_URL,
      apiKey: process.env.BAILIAN_API_KEY,
      baseURL: process.env.BAILIAN_BASE_URL,
    });
    this.model = model;
  }

  async generateText(sysPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: sysPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    return response.choices[0]?.message?.content || "";
  }

  async generateJSON<T>(sysPrompt: string, userPrompt: string): Promise<T> {
    const text = await this.generateText(sysPrompt, userPrompt);

    try {
      // 清理可能包含的 markdown 代码块标记
      const cleanText = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      return JSON.parse(cleanText) as T;
    } catch {
      throw new Error(`模型输出不是合法 JSON：${text}`);
    }
  }
}
