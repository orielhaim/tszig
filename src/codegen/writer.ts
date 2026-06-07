export class ZigWriter {
  private lines: string[] = [];
  private indentLevel: number = 0;
  private indentStr: string = "    ";

  indent(): void {
    this.indentLevel++;
  }

  dedent(): void {
    if (this.indentLevel > 0) this.indentLevel--;
  }

  writeLine(line: string): void {
    if (line === "") {
      this.lines.push("");
    } else {
      this.lines.push(this.indentStr.repeat(this.indentLevel) + line);
    }
  }

  writeRaw(text: string): void {
    this.lines.push(text);
  }

  toString(): string {
    // Clean up excessive blank lines
    const result: string[] = [];
    let prevBlank = false;

    for (const line of this.lines) {
      const isBlank = line.trim() === "";
      if (isBlank && prevBlank) continue;
      result.push(line);
      prevBlank = isBlank;
    }

    // Ensure trailing newline
    const text = result.join("\n");
    return text.endsWith("\n") ? text : text + "\n";
  }
}
