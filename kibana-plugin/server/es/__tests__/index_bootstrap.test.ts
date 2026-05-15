import {
  ensureAuditIndex,
  ensureStatusIndex,
  type IndexAwareEsClient,
} from '../index_bootstrap';
import {
  AUDIT_INDEX_MAPPING,
  STATUS_INDEX_MAPPING,
} from '../../../common/schemas/index_mappings';
import { AUDIT_INDEX, STATUS_INDEX } from '../../../common/constants';

interface CreateCall {
  index: string;
  settings?: Record<string, unknown>;
  mappings?: Record<string, unknown>;
}

function makeFakeClient(existing: Set<string>) {
  const createCalls: CreateCall[] = [];
  const client: IndexAwareEsClient = {
    indices: {
      exists: async ({ index }) => existing.has(index),
      create: async (params) => {
        createCalls.push(params);
        existing.add(params.index);
        return {};
      },
    },
  };
  return { client, createCalls };
}

describe('ensureStatusIndex', () => {
  it('creates the status index with the locked mapping when absent', async () => {
    const { client, createCalls } = makeFakeClient(new Set());

    const result = await ensureStatusIndex(client);

    expect(result).toBe('created');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].index).toBe(STATUS_INDEX);
    expect(createCalls[0].settings).toEqual(STATUS_INDEX_MAPPING.settings);
    expect(createCalls[0].mappings).toEqual(STATUS_INDEX_MAPPING.mappings);
  });

  it('does not recreate the status index when it already exists', async () => {
    const { client, createCalls } = makeFakeClient(new Set([STATUS_INDEX]));

    const result = await ensureStatusIndex(client);

    expect(result).toBe('already_exists');
    expect(createCalls).toHaveLength(0);
  });
});

describe('ensureAuditIndex', () => {
  it('creates the audit index with the locked mapping when absent', async () => {
    const { client, createCalls } = makeFakeClient(new Set());

    const result = await ensureAuditIndex(client);

    expect(result).toBe('created');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].index).toBe(AUDIT_INDEX);
    expect(createCalls[0].settings).toEqual(AUDIT_INDEX_MAPPING.settings);
    expect(createCalls[0].mappings).toEqual(AUDIT_INDEX_MAPPING.mappings);
  });

  it('does not recreate the audit index when it already exists', async () => {
    const { client, createCalls } = makeFakeClient(new Set([AUDIT_INDEX]));

    const result = await ensureAuditIndex(client);

    expect(result).toBe('already_exists');
    expect(createCalls).toHaveLength(0);
  });

  it('uses non-indexed object mappings for parameters/results/errors/summary', async () => {
    // Belt-and-suspenders: confirms the index_mappings module continues
    // to declare these as non-indexed, since downstream queries assume
    // they cannot be filtered on.
    const { client, createCalls } = makeFakeClient(new Set());
    await ensureAuditIndex(client);

    const props = (createCalls[0].mappings as { properties: Record<string, { enabled?: boolean }> })
      .properties;
    for (const field of ['parameters', 'results', 'errors', 'summary']) {
      expect(props[field].enabled).toBe(false);
    }
  });
});
