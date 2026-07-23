// ─── Help System ──────────────────────────────────────────────────────────────
// Extracted from interactive.ts — help rendering functions. These are pure
// display functions with no ReplContext dependency; they write directly to
// process.stdout using theme helpers.

import { primary, accentBright, muted, dim } from '../ui/theme.js';
import { INTERACTIVE_COMMAND_GROUPS } from './types.js';
import { findClosestCommands } from './utils.js';

export function showHelp(args: string[] = []): void {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === 'all') {
    renderFullHelp();
    return;
  }

  if (subcommand === 'search') {
    const query = args.slice(1).join(' ').toLowerCase();
    if (!query) {
      console.log(accentBright('\n  Usage: /help search <query>'));
      console.log(muted('  Filters commands by name or description substring.\n'));
      return;
    }
    renderFilteredHelp(query);
    return;
  }

  const group = INTERACTIVE_COMMAND_GROUPS.find((g) => g.title.toLowerCase() === subcommand);
  if (group) {
    renderGroupHelp(group);
    return;
  }

  const cmd = `/${subcommand}`;
  let found = false;
  for (const group of INTERACTIVE_COMMAND_GROUPS) {
    for (const [command, description] of group.commands) {
      if (command.startsWith(cmd)) {
        if (!found) {
          console.log(primary(`\n  Help for "${command}":`));
          found = true;
        }
        console.log(`    ${primary(command.padEnd(22))}  ${muted(description)}`);
      }
    }
  }
  if (found) {
    console.log('');
    return;
  }

  const suggestions = findClosestCommands(subcommand, 2, 3);
  if (suggestions.length > 0) {
    console.log(accentBright(`\n  No group or command matching "${subcommand}".`));
    console.log(`  ${muted('Did you mean:')} ${accentBright(suggestions.join(', '))}?\n`);
  } else {
    console.log(accentBright(`\n  No group or command matching "${subcommand}".`));
    console.log(
      muted('  Groups: ' + INTERACTIVE_COMMAND_GROUPS.map((g) => g.title.toLowerCase()).join(', ')),
    );
    console.log(muted('  Usage: /help all  /help <group>  /help search <query>\n'));
  }
}

export function renderFullHelp(): void {
  const cmd = (s: string) => primary(s.padEnd(22));
  console.log(primary('\n  Interactive Command Guide:\n'));
  for (const group of INTERACTIVE_COMMAND_GROUPS) {
    console.log(primary(`  ${group.title}:`));
    for (const [command, description] of group.commands) {
      console.log(`    ${cmd(command)}  ${muted(description)}`);
    }
  }
  console.log(
    muted('\n  Modes: chat (conversational), chat-headless (CI/headless), plan (approval-first), deep (governed pipeline).'),
  );
  console.log(muted('  Usage: /help <group>  /help search <query>  /help all\n'));
}

export function renderGroupHelp(group: (typeof INTERACTIVE_COMMAND_GROUPS)[number]): void {
  const cmd = (s: string) => primary(s.padEnd(22));
  console.log(primary(`\n  ${group.title} Commands:\n`));
  for (const [command, description] of group.commands) {
    console.log(`    ${cmd(command)}  ${muted(description)}`);
  }
  console.log('');
}

export function renderFilteredHelp(query: string): void {
  const cmd = (s: string) => primary(s.padEnd(22));
  const results: Array<{ group: string; command: string; description: string }> = [];
  for (const group of INTERACTIVE_COMMAND_GROUPS) {
    for (const [command, description] of group.commands) {
      if (command.toLowerCase().includes(query) || description.toLowerCase().includes(query)) {
        results.push({ group: group.title, command, description });
      }
    }
  }
  if (results.length === 0) {
    console.log(accentBright(`\n  No commands matching "${query}".\n`));
    return;
  }
  console.log(primary(`\n  Commands matching "${query}" (${results.length}):\n`));
  for (const r of results) {
    console.log(`    ${cmd(r.command)}  ${muted(r.description)}  ${dim(`[${r.group}]`)}`);
  }
  console.log('');
}
