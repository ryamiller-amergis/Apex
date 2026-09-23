/**
 * Resolve the Bedrock endpoint on App Service, where environment policy lives.
 * Visual workers receive the result in the immutable specification.
 */
export function resolveVisualModelRegion(
  modelId: string,
  explicitRegion?: string | null,
): string {
  const explicit = explicitRegion?.trim();
  if (explicit) return explicit;
  if (/^(us|eu|ap)\./.test(modelId)) return 'us-east-1';
  return process.env.AWS_REGION?.trim() || 'us-east-1';
}
