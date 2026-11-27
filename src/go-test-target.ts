import { SymbolKind, type DocumentSymbol, type Position, type SymbolInformation } from "vscode-languageserver-types";

export function isGoTestFunction(name: string) {
  return /^Test[\p{L}\p{Nd}_]*$/u.test(name) && !/^Test\p{Ll}/u.test(name);
}

function before(a: Position, b: Position) {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

export function goTestAt(symbols: readonly (DocumentSymbol | SymbolInformation)[], caret: Position) {
  const enclosing = symbols.filter(symbol => "selectionRange" in symbol && symbol.kind === SymbolKind.Function &&
    !before(caret, symbol.range.start) && before(caret, symbol.range.end));
  const target = enclosing.length === 1 ? enclosing[0].name : undefined;
  return target && isGoTestFunction(target) ? target : undefined;
}

export class CursorTestLookup {
  private generation = 0;

  invalidate() { this.generation++; }

  async resolve(read: () => Promise<string | undefined>, current: () => boolean, publish: (name: string | undefined) => void,
    launch?: { available(): boolean; blocked(): void }) {
    const generation = ++this.generation;
    const result = await read();
    if (generation !== this.generation || !current()) return;
    if (launch && !launch.available()) { launch.blocked(); return; }
    publish(result);
  }
}
