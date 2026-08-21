export function verifierMisuse(command: string): boolean {
  const trimmed = command.trim().toLowerCase()
  return /^(cat|type|Get-Content)\b/i.test(trimmed)
}
