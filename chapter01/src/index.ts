import { RequirementAnalyzer } from "./services/requirementAnalyzer";

async function main() {
  const analyzer = new RequirementAnalyzer();

  const result = await analyzer.analyze(
    "用户上传 Excel 后，系统自动解析数据并生成日报。",
  );

  console.log(result);
}

main().catch(console.error);
