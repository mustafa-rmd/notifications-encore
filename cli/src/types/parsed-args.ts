export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}
