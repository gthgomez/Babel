export function printJsonOrHuman(payload: unknown, human: string, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${human}\n`);
}

export function printJsonErrorAndExit(message: string, json: boolean): never {
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: 'fail', error: message }, null, 2)}\n`);
  } else {
    console.error(`[babel] ${message}`);
  }
  process.exit(1);
}
