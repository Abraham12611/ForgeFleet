// Self-contained UI parser stub (external-adapter convention:
// ui-parser.ts ships inside the plugin instead of upstream ui/ registry edits).
export function parseOutputToCards(output) {
  return [{ kind: 'log', text: String(output ?? '') }];
}
