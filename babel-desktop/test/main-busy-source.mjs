// Shared helper: extract busy() binding from native/main.mjs for VM-based IPC tests.
export function extractBusyBinding(source) {
  const constMatch = source.match(/const busy=([^;]+);/);
  if (constMatch) return `const busy=${constMatch[1]};`;
  const fnMatch = source.match(/function busy\(\)\{[\s\S]*?\n\}/);
  if (fnMatch) return fnMatch[0];
  return null;
}
