import { describe, expect, it } from 'vitest';
import { enrichToolFailure, toolFailure } from '../src/agent/tool-failure.js';

/** Mimics @ai-sdk/mcp MCPClientError: enumerable code/data on an Error subclass. */
class FakeMcpClientError extends Error {
  readonly name = 'MCPClientError';
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

describe('enrichToolFailure', () => {
  it('lifts GitHub errors[] and documentation_url from a Details JSON suffix', () => {
    const details = {
      message: 'Validation Failed',
      documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue',
      errors: [{ resource: 'Issue', field: 'milestone', code: 'invalid', value: '0' }],
    };
    const enriched = enrichToolFailure(
      new Error(`Validation Error: Validation Failed\nDetails: ${JSON.stringify(details)}`),
    );

    expect(enriched.errors).toEqual(details.errors);
    expect(enriched.documentation_url).toBe(details.documentation_url);
  });

  it('keeps JSON-RPC data.errors from MCPClientError', () => {
    const data = {
      message: 'Validation Failed',
      errors: [{ field: 'labels', code: 'invalid', value: 'does-not-exist' }],
      documentation_url: 'https://docs.github.com/rest',
      status: 422,
    };
    const enriched = enrichToolFailure(
      new FakeMcpClientError('Failed to create issue: Validation Failed', -32603, data),
    );

    expect(enriched.code).toBe(-32603);
    expect(enriched.errors).toEqual(data.errors);
    expect(enriched.documentation_url).toBe(data.documentation_url);
    expect(enriched.status).toBe(422);
  });

  it('adds a fixable hint when create_issue strips field details', () => {
    const enriched = enrichToolFailure(
      new FakeMcpClientError('Failed to create issue: Validation Failed', -32603),
    );

    expect(enriched.errors).toBeUndefined();
    expect(String(enriched.hint)).toMatch(/milestone/i);
    expect(String(enriched.hint)).toMatch(/0 or -1/);
  });
});

describe('toolFailure', () => {
  it('puts errors[] in the string the model sees', () => {
    const details = {
      message: 'Validation Failed',
      documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue',
      errors: [
        { resource: 'Issue', field: 'milestone', code: 'invalid', value: '-1' },
        { resource: 'Issue', field: 'labels', code: 'invalid' },
      ],
    };
    const text = toolFailure(
      new FakeMcpClientError(
        `Failed to create issue: Validation Failed\nDetails: ${JSON.stringify(details)}`,
        -32603,
      ),
      new Set(),
    );

    expect(text.length).toBeGreaterThan(200);
    expect(text).toContain('"field":"milestone"');
    expect(text).toContain('"value":"-1"');
    expect(text).toContain('"field":"labels"');
    expect(text).toContain('documentation_url');
    expect(text).toContain('docs.github.com/rest/issues');
  });

  it('does not truncate a mid-size GitHub validation payload', () => {
    const errors = Array.from({ length: 4 }, (_, index) => ({
      resource: 'Issue',
      field: index % 2 === 0 ? 'milestone' : 'labels',
      code: 'invalid',
      value: String(index === 0 ? 0 : `label-${index}`),
      message: `GitHub rejected field entry ${index} with a clear reason for the agent`,
    }));
    const details = {
      message: 'Validation Failed',
      documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue',
      errors,
    };
    const text = toolFailure(
      new Error(`Validation Error: Validation Failed\nDetails: ${JSON.stringify(details)}`),
      new Set(),
    );

    for (const entry of errors) {
      expect(text).toContain(entry.field);
      expect(text).toContain(entry.message);
    }
  });
});

it('keeps complete multiline owner details while redacting credentials and bounding the agent summary', () => {
  const secret = 'synthetic-private-value';
  const message = `Command failed\n${'diagnostic line\n'.repeat(100)}token=${secret}\nFinal diagnostic`;
  const error = new Error(message);
  const full = JSON.parse(toolFailure(error, new Set([secret]), 'owner'));
  expect(full.message).toContain('diagnostic line\n');
  expect(full.message).toContain('Final diagnostic');
  expect(full.message).not.toContain(secret);
  expect(full.message).toContain('[REDACTED]');
  expect(full.message.length).toBeGreaterThan(900);
  expect(toolFailure(error, new Set([secret])).length).toBeLessThan(400);
});
