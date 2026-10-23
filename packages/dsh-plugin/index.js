/**
 * @mebular/dsh-plugin
 *
 * Declarative DeepSeek Harness bundle. The actual wiring lives in
 * cordis.patch.yml: it registers the official MCP client plugin against the
 * already-running Mebular daemon over Streamable HTTP.
 *
 * This module intentionally has no runtime dependencies and does not import
 * anything from `@mebular/*`. The daemon is reached only through its public
 * HTTP `/mcp` endpoint.
 */

export const name = '@mebular/dsh-plugin';
export const version = '0.1.0';

export default { name, version };
