export function runtimeError(code, message, details = undefined) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}
