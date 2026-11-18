import { and, eq, gte, sql } from 'drizzle-orm';
import type { UsageStatus } from '../../shared/types.ts';
import { db } from '../db/index.ts';
import { departments, spendingAlerts, usageLogs } from '../db/schema.ts';
import { makeId } from '../utils/crypto.ts';

export function computeCalculatedCostUsd(params: {
  inputTokens: number | null;
  outputTokens: number | null;
  inputCostPer1mUsd: number;
  outputCostPer1mUsd: number;
}): number | null {
  if (params.inputTokens === null || params.outputTokens === null) {
    return null;
  }
  const inputCost = (params.inputTokens / 1_000_000) * params.inputCostPer1mUsd;
  const outputCost = (params.outputTokens / 1_000_000) * params.outputCostPer1mUsd;
  return Number((inputCost + outputCost).toFixed(8));
}

export function recordUsageAndCheckAlerts(params: {
  workspaceId: string;
  departmentId: string | null;
  agentId: string | null;
  apiKeyId: string | null;
  userLabel: string;
  providerType: string;
  modelUsed: string;
  status: UsageStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  inputCostPer1mUsd: number;
  outputCostPer1mUsd: number;
  latencyMs: number;
}): { calculatedCostUsd: number | null } {
  const now = new Date();
  const createdAt = now.toISOString();
  const calculatedCostUsd =
    params.status === 'success'
      ? computeCalculatedCostUsd({
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          inputCostPer1mUsd: params.inputCostPer1mUsd,
          outputCostPer1mUsd: params.outputCostPer1mUsd,
        })
      : null;

  db.insert(usageLogs)
    .values({
      id: makeId('log'),
      workspaceId: params.workspaceId,
      departmentId: params.departmentId,
      agentId: params.agentId,
      apiKeyId: params.apiKeyId,
      userLabel: params.userLabel,
      providerType: params.providerType,
      modelUsed: params.modelUsed,
      status: params.status,
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      actualCostUsd: calculatedCostUsd,
      latencyMs: params.latencyMs,
      createdAt,
    })
    .run();

  // Non-blocking monthly spending alert check (only when calculated cost is available)
  if (params.status === 'success' && calculatedCostUsd !== null && params.departmentId) {
    const dept = db
      .select()
      .from(departments)
      .where(eq(departments.id, params.departmentId))
      .get();

    if (dept && dept.monthlyAlertThresholdUsd > 0) {
      const periodMonth = createdAt.slice(0, 7); // YYYY-MM
      const monthStart = `${periodMonth}-01T00:00:00.000Z`;

      const row = db
        .select({
          total: sql<number>`COALESCE(SUM(${usageLogs.actualCostUsd}), 0)`,
        })
        .from(usageLogs)
        .where(
          and(
            eq(usageLogs.departmentId, dept.id),
            eq(usageLogs.status, 'success'),
            gte(usageLogs.createdAt, monthStart),
          ),
        )
        .get();

      const calculatedSpentUsd = Number((row?.total ?? 0).toFixed(6));
      if (calculatedSpentUsd >= dept.monthlyAlertThresholdUsd) {
        const existing = db
          .select()
          .from(spendingAlerts)
          .where(
            and(
              eq(spendingAlerts.departmentId, dept.id),
              eq(spendingAlerts.periodMonth, periodMonth),
            ),
          )
          .get();

        if (existing) {
          db.update(spendingAlerts)
            .set({
              thresholdUsd: dept.monthlyAlertThresholdUsd,
              actualSpentUsd: calculatedSpentUsd,
              triggeredAt: createdAt,
            })
            .where(eq(spendingAlerts.id, existing.id))
            .run();
        } else {
          db.insert(spendingAlerts)
            .values({
              id: makeId('alrt'),
              workspaceId: params.workspaceId,
              departmentId: dept.id,
              periodMonth,
              thresholdUsd: dept.monthlyAlertThresholdUsd,
              actualSpentUsd: calculatedSpentUsd,
              triggeredAt: createdAt,
              acknowledged: false,
            })
            .run();
        }
      }
    }
  }

  return { calculatedCostUsd };
}
