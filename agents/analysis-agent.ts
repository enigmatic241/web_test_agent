import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { MetricDelta } from '../db/queries.js';
import type { ScriptInventory } from './script-audit-agent.js';
import type { NetworkSimResult } from './network-sim-agent.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { logAgent } from '../utils/logger.js';

const MODEL = 'claude-sonnet-4-20250514' as const;
const MAX_TOKENS = 1500;
const MAX_PAYLOAD_CHARS = 10_000;

const regressionAnalysisSchema = z.object({
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  summary: z.string(),
  root_cause: z.string(),
  affected_metrics: z.array(z.string()),
  recommendation: z.string(),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});

export type RegressionAnalysis = z.infer<typeof regressionAnalysisSchema>;

export interface AnalysisContext {
  runId: string;
  pageSlug: string;
  deploySha: string;
  previousSha: string;
  scriptInventory: ScriptInventory;
  networkSim: NetworkSimResult;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}\n…[truncated]`;
}

async function gitDiffStat(previousSha: string, currentSha: string): Promise<Result<string>> {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      ['diff', `${previousSha}..${currentSha}`, '--stat', '--diff-filter=AM', '--', '*.js', '*.ts', '*.json'],
      { cwd: process.cwd() }
    );
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      errOut += String(d);
    });
    child.on('close', (code) => {
      if (code !== 0 && !out) {
        resolve(err(`git diff failed: ${errOut || code}`));
        return;
      }
      resolve(ok(out || '(no diff)'));
    });
  });
}

/**
 * Claude-powered regression analysis with zod validation and 10KB payload cap.
 */
export async function runAnalysisAgent(
  delta: MetricDelta,
  context: AnalysisContext
): Promise<Result<RegressionAnalysis>> {
  const started = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return err('ANTHROPIC_API_KEY not set');
  }

  const diffRes = await gitDiffStat(context.previousSha, context.deploySha);
  let gitDiffSummary = diffRes.success ? diffRes.data : '(git diff unavailable)';
  gitDiffSummary = truncate(gitDiffSummary, 4000);

  const client = new Anthropic({ apiKey });

  const userPayload = {
    metric_delta: delta.metrics,
    git_diff_summary: gitDiffSummary,
    third_party_changes: context.scriptInventory.scripts.slice(0, 10).map((s) => ({
      url: s.url,
      blockingTime_ms: s.blockingTimeMs,
      size_kb: s.sizeKb,
    })),
    network_degradation: {
      lcp_4g_to_slow3g_ratio: context.networkSim.degradation.lcp4gToSlow3gRatio,
      worst_profile: 'SLOW_3G',
      concerning: context.networkSim.degradation.concerning,
    },
  };

  let userText = JSON.stringify(userPayload);
  if (userText.length > MAX_PAYLOAD_CHARS) {
    userText = truncate(userText, MAX_PAYLOAD_CHARS);
  }

  const systemPrompt = `You are a senior web performance engineer. Analyze the following performance
regression and provide a root cause analysis. Respond ONLY with valid JSON matching the schema exactly.
Schema: { "severity": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "summary": string, "root_cause": string,
"affected_metrics": string[], "recommendation": string, "confidence": "LOW"|"MEDIUM"|"HIGH" }.
No prose outside the JSON object.`;

  const runOnce = async (retryHint?: string): Promise<Result<RegressionAnalysis>> => {
    const userMessage = retryHint ? `${userText}\n\nParse error to fix: ${retryHint}` : userText;
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const textBlock = msg.content.find((b) => b.type === 'text');
    const raw =
      textBlock && textBlock.type === 'text' ? textBlock.text : '';
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return err('Model returned non-JSON');
    }
    const parsed = regressionAnalysisSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return err(parsed.error.message);
    }
    logAgent('info', 'analysis-agent LLM call', {
      agent: 'analysis-agent',
      pageSlug: context.pageSlug,
      runId: context.runId,
      duration_ms: Date.now() - started,
    });
    return ok(parsed.data);
  };

  try {
    const first = await runOnce();
    if (first.success) {
      return first;
    }
    const second = await runOnce(first.error);
    if (second.success) {
      return second;
    }
    return err(second.error, { rawFallback: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logAgent('error', `analysis-agent failed: ${message}`, {
      agent: 'analysis-agent',
      pageSlug: context.pageSlug,
      runId: context.runId,
    });
    return err(message, { context });
  }
}
