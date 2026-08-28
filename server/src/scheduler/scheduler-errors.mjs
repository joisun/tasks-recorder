export class SchedulerError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'SchedulerError'
    this.code = code
    this.details = details
  }
}
