export class LiveSessionAuthorityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LiveSessionAuthorityError'
    this.code = code
  }
}
