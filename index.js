import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fsp } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { exec } from 'node:child_process';
import { z } from 'zod';

const PORT = parseInt(process.env.PORT || '8443', 10);
const BEARER_TOKEN = process.env.BEARER_TOKEN;

// Active sessions: sessionId → StreamableHTTPServerTransport
const sessions = new Map();

function buildServer() {
  const server = new McpServer({ name: 'operator-filesystem', version: '1.0.0' });

  server.tool('list_allowed_directories', {}, async () => ({
    content: [{ type: 'text', text: '/' }],
  }));

  server.tool('read_file', { path: z.string() }, async ({ path: p }) => {
    const text = await fsp.readFile(resolve(p), 'utf-8');
    return { content: [{ type: 'text', text }] };
  });

  server.tool('read_multiple_files', { paths: z.array(z.string()) }, async ({ paths }) => {
    const parts = await Promise.all(paths.map(async p => {
      try { return '=== ' + p + ' ===\n' + await fsp.readFile(resolve(p), 'utf-8'); }
      catch (e) { return '=== ' + p + ' ===\nError: ' + e.message; }
    }));
    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  });

  server.tool('write_file', { path: z.string(), content: z.string() }, async ({ path: p, content }) => {
    const full = resolve(p);
    await fsp.mkdir(dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf-8');
    return { content: [{ type: 'text', text: 'Written: ' + p }] };
  });

  server.tool('create_directory', { path: z.string() }, async ({ path: p }) => {
    await fsp.mkdir(resolve(p), { recursive: true });
    return { content: [{ type: 'text', text: 'Created: ' + p }] };
  });

  server.tool('list_directory', { path: z.string() }, async ({ path: p }) => {
    const entries = await fsp.readdir(resolve(p), { withFileTypes: true });
    const text = entries.map(e => (e.isDirectory() ? '[DIR]  ' : '[FILE] ') + e.name).join('\n');
    return { content: [{ type: 'text', text: text || '(empty)' }] };
  });

  server.tool('directory_tree', { path: z.string() }, async ({ path: p }) => {
    async function walk(dir, prefix) {
      let out = '';
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const last = i === entries.length - 1;
        out += prefix + (last ? '└── ' : '├── ') + e.name + '\n';
        if (e.isDirectory()) {
          out += await walk(join(dir, e.name), prefix + (last ? '    ' : '│   '));
        }
      }
      return out;
    }
    const tree = await walk(resolve(p), '');
    return { content: [{ type: 'text', text: tree || '(empty)' }] };
  });

  server.tool('move_file', { source: z.string(), destination: z.string() }, async ({ source, destination }) => {
    await fsp.rename(resolve(source), resolve(destination));
    return { content: [{ type: 'text', text: 'Moved: ' + source + ' -> ' + destination }] };
  });

  server.tool('search_files', {
    path: z.string(),
    pattern: z.string(),
    excludePatterns: z.array(z.string()).optional(),
  }, async ({ path: p, pattern, excludePatterns = [] }) => {
    const results = [];
    async function walk(dir) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (excludePatterns.some(pat => e.name.includes(pat))) continue;
        const full = join(dir, e.name);
        if (e.name.includes(pattern)) results.push(full);
        if (e.isDirectory()) await walk(full);
      }
    }
    await walk(resolve(p));
    return { content: [{ type: 'text', text: results.join('\n') || 'No matches' }] };
  });

  server.tool('run_command', {
    command: z.string().describe('Shell command to execute on the EC2 instance'),
    timeout: z.number().optional().describe('Timeout in seconds (default 60)'),
  }, ({ command, timeout = 60 }) => new Promise((resolve) => {
    exec(command, { timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [
        stdout && 'STDOUT:\n' + stdout,
        stderr && 'STDERR:\n' + stderr,
        err && !stderr ? 'ERROR: ' + err.message : null,
      ].filter(Boolean).join('\n');
      resolve({ content: [{ type: 'text', text: output || '(no output)' }] });
    });
  }));

  server.tool('get_file_info', { path: z.string() }, async ({ path: p }) => {
    const stat = await fsp.stat(resolve(p));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          path: p,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          permissions: stat.mode.toString(8),
        }, null, 2),
      }],
    };
  });

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : undefined); }
      catch { resolve(undefined); }
    });
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req, res) => {
  // Bearer token auth
  if ((req.headers['authorization'] || '') !== 'Bearer ' + BEARER_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const sessionId = req.headers['mcp-session-id'];

  try {
    if (req.method === 'POST') {
      let transport;
      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId);
      } else {
        // New session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, transport),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await buildServer().connect(transport);
      }
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);

    } else if (req.method === 'GET') {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      await sessions.get(sessionId).handleRequest(req, res);

    } else if (req.method === 'DELETE') {
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId).handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.writeHead(404);
        res.end();
      }

    } else {
      res.writeHead(405);
      res.end();
    }
  } catch (err) {
    console.error('Error handling request:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('Operator MCP server listening on port ' + PORT);
});