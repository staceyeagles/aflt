'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../lib/usage');

describe('usage normalization', () => {
  it('normalizes Cursor result.usage (uncached inputTokens)', () => {
    const raw = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 2133,
      duration_api_ms: 2133,
      result: 'OK',
      session_id: '574d45da-05fd-4c13-ac3a-fe96ae685aac',
      request_id: 'f417c52c-2819-40f5-90d6-d2d39cdd8ef8',
      usage: {
        inputTokens: 6187,
        outputTokens: 40,
        cacheReadTokens: 3968,
        cacheWriteTokens: 0,
        reasoningTokens: 39,
      },
    };
    const u = usage.normalizeCursorUsage(raw.usage, {
      durationMs: raw.duration_ms,
      requestId: raw.request_id,
      source: 'cursor-result',
    });
    assert.equal(u.inputTokens, 6187);
    assert.equal(u.cacheRead, 3968);
    assert.equal(u.cacheWrite, 0);
    assert.equal(u.totalInput, 10155);
    assert.equal(u.outputTokens, 40);
    assert.equal(u.reasoningTokens, 39);
    assert.equal(u.totalTokens, 10195);
    assert.equal(u.promptToResponse, 253.88);
    assert.equal(u.cost, null);
    assert.equal(u.accuracy, 'reported');
    assert.equal(u.source, 'cursor-result');
    assert.equal(u.cli, 'cursor');
    assert.equal(u.durationMs, 2133);
    assert.equal(u.requestId, 'f417c52c-2819-40f5-90d6-d2d39cdd8ef8');
  });

  it('normalizes Copilot usage_record (cache-inclusive inputTokens)', () => {
    const raw = {
      model: 'claude-haiku-4.5',
      inputTokens: 16130,
      outputTokens: 56,
      cacheReadTokens: 0,
      cacheWriteTokens: 16120,
      reasoningTokens: 49,
      cost: 0.33,
      duration: 1008,
    };
    const u = usage.normalizeCopilotUsage(raw, { source: 'copilot-usage-record' });
    assert.equal(u.inputTokens, 10);
    assert.equal(u.cacheRead, 0);
    assert.equal(u.cacheWrite, 16120);
    assert.equal(u.totalInput, 16130);
    assert.equal(u.outputTokens, 56);
    assert.equal(u.reasoningTokens, 49);
    assert.equal(u.totalTokens, 16186);
    assert.equal(u.premiumRequests, 0.33);
    assert.equal(u.cost, null);
    assert.equal(u.durationMs, 1008);
    assert.equal(u.model, 'claude-haiku-4.5');
    assert.equal(u.cli, 'copilot');
    assert.equal(u.accuracy, 'reported');
  });

  it('normalizes OpenCode step_finish tokens + cost', () => {
    const part = {
      type: 'step-finish',
      tokens: {
        total: 6788,
        input: 6753,
        output: 35,
        reasoning: 0,
        cache: { write: 0, read: 0 },
      },
      cost: 0,
    };
    const u = usage.normalizeOpenCodeUsage(part, { source: 'opencode-run-json' });
    assert.equal(u.inputTokens, 6753);
    assert.equal(u.cacheRead, 0);
    assert.equal(u.cacheWrite, 0);
    assert.equal(u.totalInput, 6753);
    assert.equal(u.outputTokens, 35);
    assert.equal(u.reasoningTokens, 0);
    assert.equal(u.totalTokens, 6788);
    assert.equal(u.cost, 0);
    assert.equal(u.cli, 'opencode');
    assert.equal(u.accuracy, 'reported');
  });

  it('rejects all-zero OpenCode error records as not reported', () => {
    const u = usage.normalizeOpenCodeUsage({
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    });
    assert.equal(u, null);
  });

  it('estimates usage from chars/4', () => {
    const u = usage.estimateUsageFromText({
      prompt: 'abcd', // 4 chars → 1
      reply: 'abcdefgh', // 8 chars → 2
      cli: 'cursor',
    });
    assert.equal(u.inputTokens, 1);
    assert.equal(u.outputTokens, 2);
    assert.equal(u.totalInput, 1);
    assert.equal(u.cacheRead, null);
    assert.equal(u.cacheWrite, null);
    assert.equal(u.reasoningTokens, null);
    assert.equal(u.accuracy, 'estimated');
    assert.equal(u.source, 'estimated-chars');
  });

  it('never overwrites reported with estimated', () => {
    const reported = usage.normalizeCursorUsage({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const estimated = usage.estimateUsageFromText({
      prompt: 'hello',
      reply: 'world',
      cli: 'cursor',
    });
    assert.equal(usage.shouldReplaceUsage(reported, estimated), false);
    assert.equal(usage.shouldReplaceUsage(estimated, reported), true);
    assert.equal(usage.shouldReplaceUsage(null, estimated), true);
    assert.equal(usage.shouldReplaceUsage(estimated, estimated), false);
    assert.equal(usage.shouldReplaceUsage(reported, reported), false);
  });

  it('summarizes session usage across turns', () => {
    const t1 = {
      usage: usage.normalizeCursorUsage({
        inputTokens: 6187,
        outputTokens: 40,
        cacheReadTokens: 3968,
        cacheWriteTokens: 0,
        reasoningTokens: 39,
      }),
    };
    const t2 = {
      usage: usage.estimateUsageFromText({
        prompt: 'xxxx',
        reply: 'yyyy',
        cli: 'cursor',
        model: 'gpt-test',
      }),
    };
    const summary = usage.summarizeSessionUsage([t1, t2], {
      updatedAt: '2026-11-21T00:00:00.000Z',
    });
    assert.equal(summary.turnCount, 2);
    assert.equal(summary.reportedTurns, 1);
    assert.equal(summary.estimatedTurns, 1);
    assert.equal(summary.accuracy, 'partial');
    assert.equal(summary.totalInput, 10155 + 1);
    assert.equal(summary.outputTokens, 40 + 1);
    assert.equal(summary.cli, 'cursor');
    assert.ok(summary.models.includes('gpt-test'));
  });

  it('formats meta bit and tooltip lines', () => {
    const u = usage.normalizeCursorUsage({
      inputTokens: 6187,
      outputTokens: 40,
      cacheReadTokens: 3968,
      cacheWriteTokens: 0,
      reasoningTokens: 39,
    });
    const summary = usage.summarizeSessionUsage([{ usage: u }]);
    const bit = usage.formatUsageMetaBit(summary);
    assert.match(bit, /10\.2k tok/);
    assert.match(bit, /254:1|253:1/);
    const tip = usage.formatUsageTooltipLine(u);
    assert.match(tip, /10,155 in → 40 out/);
    assert.match(tip, /reported/);
  });

  it('Copilot result.usage with only premiumRequests is partial', () => {
    const u = usage.normalizeCopilotUsage(
      { premiumRequests: 0.33, totalApiDurationMs: 1000, sessionDurationMs: 2000, codeChanges: {} },
      { source: 'copilot-result' }
    );
    assert.equal(u.premiumRequests, 0.33);
    assert.equal(u.cost, null);
    assert.equal(u.accuracy, 'partial');
    assert.equal(u.inputTokens, null);
  });

  it('project rollup stays reported when compacting all-reported sessions', () => {
    const reported = usage.normalizeCursorUsage({
      inputTokens: 6208,
      outputTokens: 41,
      cacheReadTokens: 3968,
      cacheWriteTokens: 0,
      reasoningTokens: 40,
    });
    const session = usage.summarizeSessionUsage([{ usage: reported }]);
    assert.equal(session.accuracy, 'reported');
    assert.equal(session.turnCount, 1);
    const compact = usage.compactUsageSummary(session);
    assert.equal(compact.accuracy, 'reported');
    assert.equal(compact.reportedTurns, 1);
    // Dashboard project nodes merge already-compacted session.usage values.
    const project = usage.compactUsageSummary(usage.mergeUsageSummaries([compact]));
    assert.equal(project.accuracy, 'reported');
    assert.equal(project.turnCount, 1);
    assert.equal(project.totalTokens, session.totalTokens);
    // Legacy compact payloads without reportedTurns still roll up correctly.
    const legacy = { ...compact };
    delete legacy.reportedTurns;
    delete legacy.estimatedTurns;
    delete legacy.partialTurns;
    const fromLegacy = usage.mergeUsageSummaries([legacy]);
    assert.equal(fromLegacy.accuracy, 'reported');
    assert.equal(fromLegacy.reportedTurns, 1);
    const estimated = usage.estimateUsageFromText({
      prompt: 'hello',
      reply: 'world',
      cli: 'cursor',
    });
    const mixed = usage.mergeUsageSummaries([
      compact,
      usage.compactUsageSummary(usage.summarizeSessionUsage([{ usage: estimated }])),
    ]);
    assert.equal(mixed.accuracy, 'partial');
    assert.equal(mixed.turnCount, 2);
  });

  it('deltaCopilotModelMetrics subtracts checkpoints', () => {
    const before = {
      'claude-haiku-4.5': {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 50,
        reasoningTokens: 0,
      },
    };
    const after = {
      'claude-haiku-4.5': {
        inputTokens: 16130,
        outputTokens: 56,
        cacheReadTokens: 0,
        cacheWriteTokens: 16120,
        reasoningTokens: 49,
      },
    };
    const delta = usage.deltaCopilotModelMetrics(after, before);
    const u = usage.normalizeCopilotUsage(delta, { source: 'copilot-usage-checkpoint' });
    assert.equal(u.totalInput, 16030);
    assert.equal(u.outputTokens, 46);
    assert.equal(u.cacheWrite, 16070);
    assert.equal(u.source, 'copilot-usage-checkpoint');
  });
});
