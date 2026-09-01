import OpenAI from "openai";
import "dotenv/config";

/**
 * 需求描述：写一个 Python 函数，接收一个用户列表，返回年龄大于 18 岁用户的邮箱地址，并处理空值情况。
 */

const client = new OpenAI({
  apiKey: process.env.BAILIAN_API_KEY,
  baseURL: process.env.BAILIAN_BASE_URL,
});

async function generateCode() {
  const response = await client.responses.create({
    model: "qwen3.8-max",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "你是一名资深 Python 工程师，请输出简洁、可读、可直接运行的代码。",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
                    请写一个 Python 函数，要求如下：
                    1. 输入是一个用户列表，每个用户是一个字典，可能包含 name、age、email 字段
                    2. 返回年龄大于 18 岁用户的邮箱地址列表
                    3. 如果 age 为空、email 缺失或为 None, 则跳过
                    4. 使用类型注解
                    5. 先简要解释思路，再写代码
                `.trim(),
          },
        ],
      },
    ],
  });

  console.log(response.output_text);
}

generateCode().catch(console.error);
