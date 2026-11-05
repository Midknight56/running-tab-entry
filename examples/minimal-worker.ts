// A kit server that bills agents: one priced tool, the free tab tools, and a tab that is due at $5.00.
import { McpServer, type Tool } from 'mcp-on-workers'
import { agentFromRequest, agentTools, withTab, type TabCtx } from '../src/tab'

const hello: Tool<TabCtx> = {
  name: 'hello', title: 'Say hello', description: 'Greets someone.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async run(args) { return { content: [{ type: 'text', text: `Hello, ${args.name}!` }] } },
}

export default {
  async fetch(request: Request, env: { DB: D1Database; SESSION_SECRET: string }) {
    return new McpServer<TabCtx>({
      info: { name: 'hello', title: 'Hello', version: '1.0.0' }, secret: env.SESSION_SECRET, allowOrigin: () => false,
      tools: [withTab(hello, { price_cents: 2 }), ...agentTools],
      context: async (req) => ({ tab: { db: env.DB, agent: await agentFromRequest(env.DB, req), origin: new URL(req.url).origin, thresholdCents: 500 } }),
    }).handle(request)
  },
}
