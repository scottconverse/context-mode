import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverScript = process.argv[2] || 'server/index.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: [serverScript],
  cwd: process.cwd()
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Connected. ${tools.length} tools available:`);
for (const t of tools) {
  console.log(`  - ${t.name}`);
}

async function callTool(name, args = {}) {
  console.log(`\n--- ${name} ---`);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text || '(no text)';
    console.log(text.slice(0, 300));
    return result;
  } catch (err) {
    console.log('ERROR:', err.message);
    return null;
  }
}

// Smoke test 1: ctx_doctor (no args)
await callTool('ctx_doctor');

// Smoke test 2: ctx_execute
await callTool('ctx_execute', {
  language: 'python',
  code: 'print("Hello from context-mode sandbox")'
});

// Smoke test 3: ctx_index
await callTool('ctx_index', {
  content: '# Test Doc\n\nContext-mode reduces context consumption by sandboxing.\n\n## Architecture\n\nFTS5 knowledge base with BM25 ranking.',
  source: 'smoke-test'
});

// Smoke test 4: ctx_search
await callTool('ctx_search', {
  query: 'BM25 knowledge base'
});

// Smoke test 5: ctx_stats
await callTool('ctx_stats');

await client.close();
console.log('\n=== SMOKE TEST COMPLETE ===');
