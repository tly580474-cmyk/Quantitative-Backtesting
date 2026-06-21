export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DATASET_NOT_FOUND: 'DATASET_NOT_FOUND',
  RESULT_NOT_FOUND: 'RESULT_NOT_FOUND',
  STRATEGY_NOT_FOUND: 'STRATEGY_NOT_FOUND',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  DUPLICATE_CHECKSUM: 'DUPLICATE_CHECKSUM',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ApiErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}

export function apiError(
  code: ErrorCode,
  message: string,
  details?: unknown,
): ApiErrorResponse {
  return { error: code, message, details };
}

export function dbUnavailable(): ApiErrorResponse {
  return apiError(
    ErrorCodes.DB_UNAVAILABLE,
    '数据库服务不可用，请稍后重试',
  );
}
