export type ToolFailureCategory = 'invalid_argument' | 'query_error' | 'data_unavailable'
  | 'upstream_unavailable' | 'permission_denied' | 'execution_error';

export interface ToolFailure {
  category: ToolFailureCategory;
  evidence: 'exit_status' | 'structured_result' | 'output_signature';
  /** Null means unknown. A pipeline's zero exit code is retained rather than fabricated. */
  reportedExitCode: number | null;
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => resultText(item?.text ?? item)).join('\n');
  return value == null ? '' : JSON.stringify(value);
}

export function researchDataUsable(output: unknown): boolean | undefined {
  try {
    let value = JSON.parse(resultText(output));
    if (typeof value.output === 'string') value = JSON.parse(value.output);
    if (value.kind === 'research-data' && value.ok === true && typeof value.usable === 'boolean') return value.usable;
  } catch { /* No structured result, so usefulness is unknown. */ }
  return undefined;
}

/** Inspect before display truncation. Narrow runtime signatures avoid matching ordinary mentions of errors. */
export function detectToolFailure(output: unknown, failed = false, exitCode?: number | null): ToolFailure | undefined {
  let text = resultText(output);
  const exitPrefix = /^Exit code (\d+)\r?\n/.exec(text);
  if (exitPrefix) { exitCode ??= Number(exitPrefix[1]); text = text.slice(exitPrefix[0].length); }
  let structured = false;
  try {
    const value = JSON.parse(text);
    if (value && !Array.isArray(value) && typeof value === 'object') {
      structured = value.ok === false;
      if (typeof value.exitCode === 'number') exitCode = value.exitCode;
      text = resultText(value.error ?? value.output ?? value);
      if (typeof value.output === 'string') {
        try { structured ||= JSON.parse(value.output)?.ok === false; } catch { /* Plain nested stdout. */ }
      }
    }
  } catch {
    // A shell fallback may print multiple compact JSON results. Inspect complete
    // result lines, not arbitrary JSON fragments or mentions in ordinary prose.
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const value = JSON.parse(line);
        if (value?.ok === false) { structured = true; text = resultText(value.error ?? value); break; }
      } catch { /* Plain stdout is expected. */ }
    }
  }
  const rules: Array<[ToolFailureCategory, RegExp]> = [
    ['invalid_argument', /^(?:INVALID_ARGUMENT:|未知命令：|npm (?:ERR!|error) Missing script:)/m],
    ['query_error', /^(?:(?:Error: )?Failed to (?:extract statements|prepare statement): )?(?:Binder|Parser|Catalog|Conversion|Invalid Input) Error:/m],
    ['permission_denied', /^(?:Error: )?(?:Access denied for user|Permission denied|EACCES\b)/m],
    ['data_unavailable', /^(?:DATA_UNAVAILABLE|COVERAGE_INSUFFICIENT|STALE_DATA):/m],
    ['upstream_unavailable', /^(?:UPSTREAM_UNAVAILABLE:|(?:Error: )?(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b)/m],
    ['execution_error', /^(?:Traceback \(most recent call last\):|SyntaxError:|ModuleNotFoundError:|ReferenceError:|Error: Cannot find module)/m],
  ];
  const category = rules.find(([, pattern]) => pattern.test(text))?.[0];
  if (!failed && !structured && !(typeof exitCode === 'number' && exitCode !== 0) && !category) return undefined;
  return {
    category: category ?? 'execution_error',
    evidence: failed || (typeof exitCode === 'number' && exitCode !== 0) ? 'exit_status'
      : structured ? 'structured_result' : 'output_signature',
    reportedExitCode: exitCode ?? null,
  };
}

export function isExecutedCommand(toolName: string | undefined, input = ''): boolean {
  if (!['Bash', 'bash', 'powershell', 'command', 'exec_command', 'shell_command', 'Shell'].includes(toolName ?? '')) return false;
  // Source/document searches can legitimately print example errors; do not reclassify them.
  return !/(?:^|[;&|\s"'])(?:cat|rg|grep|head|tail|Get-Content|Select-String)\s/i.test(input.replace(/\|\s*(?:head|tail)\b[^;\n]*/g, ''));
}
