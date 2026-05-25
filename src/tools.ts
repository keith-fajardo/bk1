import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';

export const PROJECT_DIR = resolve(process.env.DBT_PROJECT_DIR ?? process.cwd());

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'run_dbt_command',
    description: 'Run a dbt CLI command in the project directory. Examples: "dbt compile --select stg_orders", "dbt test --select marts.fct_orders+".',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The full dbt command to run.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the dbt project. Use before editing to avoid overwriting content.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root, e.g. "models/staging/stg_orders.sql".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the project. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root.',
        },
        content: {
          type: 'string',
          description: 'Full file content to write.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files matching a glob pattern in the project. Useful for exploring model structure.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern relative to project root. Examples: "models/**/*.sql", "models/staging/*.yml".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run any shell command in the project directory. Use for grep, find, reading manifest.json, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute.',
        },
      },
      required: ['command'],
    },
  },
];

function safeResolvePath(relativePath: string): string {
  const full = resolve(PROJECT_DIR, relativePath);
  if (!full.startsWith(PROJECT_DIR + '/') && full !== PROJECT_DIR) {
    throw new Error(`Path outside project directory: ${relativePath}`);
  }
  return full;
}

async function runDbtCommand(command: string): Promise<string> {
  const parts = command.trim().split(/\s+/);
  const proc = Bun.spawn(parts, {
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return (out + err).trim();
}

function readFile(path: string): string {
  const full = safeResolvePath(path);
  if (!existsSync(full)) return `File not found: ${path}`;
  return readFileSync(full, 'utf-8');
}

function writeFile(path: string, content: string): string {
  const full = safeResolvePath(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return `Wrote ${path}`;
}

async function listFiles(pattern: string): Promise<string> {
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: PROJECT_DIR, onlyFiles: true })) {
    files.push(file);
    if (files.length >= 100) break;
  }
  if (files.length === 0) return 'No files found.';
  return files.sort().join('\n');
}

async function runBash(command: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', command], {
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const combined = (out + err).trim();
  return combined.length > 8000 ? combined.substring(0, 8000) + '\n...(truncated)' : combined;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'run_dbt_command': return await runDbtCommand(input.command as string);
      case 'read_file':       return readFile(input.path as string);
      case 'write_file':      return writeFile(input.path as string, input.content as string);
      case 'list_files':      return await listFiles(input.pattern as string);
      case 'bash':            return await runBash(input.command as string);
      default:                return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
