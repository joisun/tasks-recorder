const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/
const REASONING_LEVEL = /^[a-z][a-z0-9_-]{0,15}$/

export function isCodexModelSlug(value) {
  return typeof value === 'string' && MODEL_SLUG.test(value)
}

export function isCodexReasoningLevel(value) {
  return typeof value === 'string' && REASONING_LEVEL.test(value)
}
