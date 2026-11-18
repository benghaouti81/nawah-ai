import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  yamlAgentTemplateSchema,
  type YamlAgentTemplate,
} from '../../shared/types.ts';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates', 'agents');

export function loadDiskTemplates(): YamlAgentTemplate[] {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    return [];
  }

  const files = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const templates: YamlAgentTemplate[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
    const parsed = YAML.parse(raw);
    const result = yamlAgentTemplateSchema.safeParse(parsed);
    if (result.success) {
      templates.push(result.data);
    } else {
      console.error(
        `Invalid agent template ${file}:`,
        result.error.flatten().fieldErrors,
      );
    }
  }
  return templates;
}

export function getDiskTemplateRaw(idOrSlug: string): string | null {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    return null;
  }
  const files = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
    const parsed = YAML.parse(raw);
    const result = yamlAgentTemplateSchema.safeParse(parsed);
    if (
      result.success &&
      (result.data.id === idOrSlug || result.data.slug === idOrSlug)
    ) {
      return raw;
    }
  }
  return null;
}

export function parseAndValidateAgentYaml(yamlContent: string): YamlAgentTemplate {
  const parsed = YAML.parse(yamlContent);
  return yamlAgentTemplateSchema.parse(parsed);
}

export function serializeAgentToYaml(agent: {
  id: string;
  templateSourceId: string | null;
  slug: string;
  name: string;
  description: string;
  temperature: number;
  systemPrompt: string;
  contextDocs: string;
  mcpPermissions: {
    serverIds: string[];
    allowedTools: string[];
    readOnly: boolean;
  };
}): string {
  const doc: YamlAgentTemplate = {
    id: agent.templateSourceId || agent.slug,
    version: '0.1',
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    temperature: agent.temperature,
    system_prompt: agent.systemPrompt,
    context_docs: agent.contextDocs,
    mcp_permissions: {
      read_only: agent.mcpPermissions.readOnly,
      allowed_tools: agent.mcpPermissions.allowedTools,
      server_ids: agent.mcpPermissions.serverIds,
    },
  };
  return YAML.stringify(doc, { lineWidth: 100 });
}
