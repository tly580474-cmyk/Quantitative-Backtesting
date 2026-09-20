export interface SanitizedSecretReplacement {
  value: string;
  blocked: boolean;
}

/** Prevent a credential manager from copying the active admin bearer token into a business secret field. */
export function sanitizeSecretReplacement(
  candidate: string,
  adminToken: string,
): SanitizedSecretReplacement {
  if (adminToken.trim().length > 0 && candidate.includes(adminToken.trim())) {
    return { value: '', blocked: true };
  }
  return { value: candidate, blocked: false };
}
