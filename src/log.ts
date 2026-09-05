// stdout is the MCP protocol channel; every diagnostic goes to stderr.
export const log = {
  info: (...args: unknown[]) => console.error('[indesign-mcp]', ...args),
  warn: (...args: unknown[]) => console.error('[indesign-mcp] warning:', ...args),
  error: (...args: unknown[]) => console.error('[indesign-mcp] error:', ...args),
};
