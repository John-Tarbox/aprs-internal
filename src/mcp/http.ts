/**
 * MCP HTTP entrypoint.
 *
 * The OAuthProvider in src/index.ts dispatches API requests (paths under
 * /mcp) here once the bearer token has been validated; auth state is
 * surfaced via `ctx.props`. We build a fresh stateless McpServer + Web
 * Standards transport per request, register the Kanban tools, and let the
 * SDK's transport.handleRequest do the JSON-RPC mechanics.
 *
 * Stateless mode (sessionIdGenerator omitted) suits this server: every
 * MCP tool call is independent — there's no conversational state we want
 * to keep across requests, and per-request DO instances would amplify
 * cost for no benefit. Streamable HTTP still works fine in stateless mode;
 * Claude.ai just won't reuse a session ID across calls.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Env } from '../env';
import { registerKanbanTools, type McpProps } from './tools';

/**
 * ExportedHandler-shaped object that OAuthProvider can call into.
 * Per request we instantiate a fresh server + transport. The SDK is
 * designed for this — they're cheap to create and the transport closes
 * automatically once the response is returned.
 */
export const mcpApiHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // OAuthProvider attaches the grant's `props` to ctx at request time;
    // CF's base ExecutionContext type doesn't know about it, so we read
    // through a cast.
    const props = (ctx as ExecutionContext & { props?: McpProps }).props;
    if (!props || typeof props.userId !== 'number') {
      // Should never happen — OAuthProvider only routes here after token
      // validation succeeds. Belt-and-suspenders 401.
      return new Response('Unauthorized', { status: 401 });
    }

    const server = new McpServer(
      {
        name: 'aprs-internal-kanban',
        version: '0.1.0',
      },
      {
        capabilities: { tools: {} },
        instructions:
          'Tools for the APRS Foundation internal Kanban. Use list_boards / get_board for read; ' +
          'create_card / update_card / move_card / etc. for writes. Staff-only operations include ' +
          'create_board, bulk_import_cards, and all column/label management — non-staff calls return forbidden.',
      }
    );
    registerKanbanTools(server, env);

    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session IDs, no per-session memory. Each request is
      // independent — initialise → list_tools / call_tool → done.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    // Surface the OAuth grant props to tool handlers via authInfo.extra.
    // tools.ts reads this through requireProps(extra).
    return transport.handleRequest(request, {
      authInfo: {
        token: '<oauth-bearer>',         // opaque to tools — props is what matters
        clientId: 'mcp',                 // placeholder; OAuthProvider validated the real one
        scopes: ['kanban'],
        extra: { props },
      },
    });
  },
};
