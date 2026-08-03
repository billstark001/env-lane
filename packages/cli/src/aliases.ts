import type { Command } from 'commander'

export function applyCliAliases(program: Command, aliases: Record<string, string>): void {
  for (const [commandName, alias] of Object.entries(aliases)) {
    program.commands.find((command) => command.name() === commandName)?.alias(alias)
  }
}
