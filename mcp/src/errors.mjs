export class TaskRecorderError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'TaskRecorderError'
    this.code = code
    this.details = details
  }
}
