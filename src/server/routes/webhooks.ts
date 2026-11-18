import { Router } from 'express';
import { z } from 'zod';
import { GatewayError } from '../engine/agent-hydrator.ts';
import { requireAuth } from '../middleware/auth.ts';
import { executeAgentTurn } from './v1-openai.ts';

export const webhooksRouter = Router();
webhooksRouter.use(requireAuth);

const gitPrPayloadSchema = z.object({
  agentSlug: z.string().trim().min(1).default('code-reviewer'),
  repository: z.string().trim().min(1),
  prNumber: z.union([z.string(), z.number()]).transform(String),
  title: z.string().trim().min(1),
  description: z.string().optional().default(''),
  diff: z.string().min(1, 'PR diff content is required'),
});

const slackPayloadSchema = z.object({
  agentSlug: z.string().trim().min(1).default('code-reviewer'),
  channel: z.string().trim().optional().default('#engineering'),
  userName: z.string().trim().optional().default('slack-user'),
  text: z.string().trim().min(1, 'Prompt text is required'),
});

webhooksRouter.post('/git-pr', async (req, res) => {
  const auth = req.auth!;
  const parsed = gitPrPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid Git PR webhook payload',
      },
    });
    return;
  }

  const { agentSlug, repository, prNumber, title, description, diff } = parsed.data;
  const prompt = [
    `Repository: ${repository}`,
    `Pull Request #${prNumber}: ${title}`,
    description ? `Description:\n${description}` : '',
    `Diff:\n\`\`\`diff\n${diff}\n\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const result = await executeAgentTurn({
      auth,
      model: agentSlug.startsWith('agent/') ? agentSlug : `agent/${agentSlug}`,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({
      ok: true,
      repository,
      prNumber,
      agent: result.model,
      reviewMarkdown: result.content,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        calculatedCostUsd: result.calculatedCostUsd,
        costBasis: 'configured_model_pricing',
        latencyMs: result.latencyMs,
      },
      toolEvents: result.toolEvents,
    });
  } catch (err) {
    const gwErr =
      err instanceof GatewayError
        ? err
        : new GatewayError(
            502,
            'webhook_execution_failed',
            err instanceof Error ? err.message : 'PR review execution failed',
          );
    res.status(gwErr.statusCode).json({
      ok: false,
      error: { code: gwErr.errorCode, message: gwErr.message },
    });
  }
});

webhooksRouter.post('/slack', async (req, res) => {
  const auth = req.auth!;
  const parsed = slackPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid Slack adapter payload',
      },
    });
    return;
  }

  const { agentSlug, channel, userName, text } = parsed.data;

  try {
    const result = await executeAgentTurn({
      auth,
      model: agentSlug.startsWith('agent/') ? agentSlug : `agent/${agentSlug}`,
      messages: [
        {
          role: 'user',
          content: `[Slack ${channel} · @${userName}]\n${text}`,
        },
      ],
    });

    res.json({
      ok: true,
      response_type: 'in_channel',
      agent: result.model,
      text: result.content,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        calculatedCostUsd: result.calculatedCostUsd,
        costBasis: 'configured_model_pricing',
        latencyMs: result.latencyMs,
      },
      toolEvents: result.toolEvents,
    });
  } catch (err) {
    const gwErr =
      err instanceof GatewayError
        ? err
        : new GatewayError(
            502,
            'slack_execution_failed',
            err instanceof Error ? err.message : 'Slack execution failed',
          );
    res.status(gwErr.statusCode).json({
      ok: false,
      error: { code: gwErr.errorCode, message: gwErr.message },
    });
  }
});
