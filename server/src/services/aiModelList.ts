const MAX_AI_MODELS = 20;
const MAX_MODEL_NAME_LENGTH = 200;

export function parseAiModelList(value: string): string[] {
  return [...new Set(value.split(';').map((item) => item.trim()).filter(Boolean))];
}

export function getAiModelListValidationError(value: string): string | null {
  if (!value.trim()) return '大模型列表不能为空';
  const entries = value.split(';').map((item) => item.trim());
  if (entries.some((item) => !item)) return '模型之间使用英文分号分隔，不能包含空模型项';
  if (entries.length > MAX_AI_MODELS) return `最多配置 ${MAX_AI_MODELS} 个模型`;
  if (entries.some((item) => item.length > MAX_MODEL_NAME_LENGTH)) {
    return `单个模型名称不能超过 ${MAX_MODEL_NAME_LENGTH} 个字符`;
  }
  if (entries.some((item) => /[\r\n]/.test(item))) return '模型名称不能包含换行符';
  if (new Set(entries).size !== entries.length) return '模型列表不能包含重复项';
  return null;
}

export function isValidAiModelList(value: string): boolean {
  return getAiModelListValidationError(value) === null;
}
