import type { RequirementAnalysis } from "./schemas";

export function isRequirementAnalysis(
  data: unknown,
): data is RequirementAnalysis {
  if (typeof data != "object" || data === null) return false;

  const obj = data as Record<string, unknown>;

  return (
    typeof obj.summary == "string" &&
    Array.isArray(obj.modules) &&
    obj.modules.every(
      (item) =>
        typeof item.name == "string" && typeof item.responsibility == "string",
    ) &&
    Array.isArray(obj.risks) &&
    obj.risks.every((risk) => typeof risk == "string") &&
    Array.isArray(obj.questions) &&
    obj.questions.every((question) => typeof question == "string")
  );
}
