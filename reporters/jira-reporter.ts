import type { RegressionAnalysis } from '../agents/analysis-agent.js';
import type { PageConfig } from '../config/pages.js';
import type { ScriptInventory } from '../agents/script-audit-agent.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

function authHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

/**
 * Creates or updates a Jira issue for HIGH/CRITICAL regressions.
 */
export async function createOrCommentPerfIssue(params: {
  page: PageConfig;
  runId: string;
  deploySha: string;
  analysis: RegressionAnalysis;
  metricTableMarkdown: string;
  networkSummary: string;
  worstScript?: ScriptInventory['scripts'][0];
}): Promise<Result<string>> {
  const base = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_API_TOKEN;
  const project = process.env.JIRA_PROJECT_KEY;
  const email = process.env.JIRA_USER_EMAIL;

  if (!base || !token || !project || !email) {
    return err('JIRA_BASE_URL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, JIRA_USER_EMAIL must be set');
  }

  const { page, runId, deploySha, analysis, metricTableMarkdown, networkSummary, worstScript } =
    params;

  const summary = `[PERF] ${page.name} — ${analysis.affected_metrics[0] ?? 'metrics'} (${analysis.severity})`;

  const description = `h2. Summary
${analysis.summary}

h2. Metrics affected
${metricTableMarkdown}

h2. Root cause
${analysis.root_cause}

h2. Recommendation
${analysis.recommendation}

h2. Evidence
* Run ID: ${runId}
* Deploy SHA: ${deploySha}
* Network: ${networkSummary}
* Top script: ${worstScript?.url ?? 'n/a'} (${worstScript?.blockingTimeMs ?? 0}ms blocking)
`;

    const searchUrl = `${base.replace(/\/$/, '')}/rest/api/3/search`;
  const issueUrl = `${base.replace(/\/$/, '')}/rest/api/3/issue`;

  try {
    const jql = `project = ${project} AND labels = "perf-regression" AND statusCategory != Done AND component = "${page.slug}"`;
    const searchRes = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader(email, token),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jql,
        maxResults: 1,
        fields: ['key'],
      }),
    });

    if (searchRes.ok) {
      const data = (await searchRes.json()) as { issues?: Array<{ key: string }> };
      const key = data.issues?.[0]?.key;
      if (key) {
        const commentUrl = `${base.replace(/\/$/, '')}/rest/api/3/issue/${key}/comment`;
        await fetch(commentUrl, {
          method: 'POST',
          headers: {
            Authorization: authHeader(email, token),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            body: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: description }],
                },
              ],
            },
          }),
        });
        return ok(key);
      }
    }

    const priority = analysis.severity === 'CRITICAL' ? { name: 'Highest' } : { name: 'High' };

    const createRes = await fetch(issueUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader(email, token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { key: project },
          summary,
          description: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: description }],
              },
            ],
          },
          issuetype: { name: 'Task' },
          labels: ['perf-regression', 'automated', page.slug],
          priority,
          components: [{ name: 'Performance' }],
        },
      }),
    });

    if (!createRes.ok) {
      const t = await createRes.text();
      return err(`Jira create failed: ${createRes.status} ${t}`);
    }
    const created = (await createRes.json()) as { key: string };
    return ok(created.key);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message);
  }
}
