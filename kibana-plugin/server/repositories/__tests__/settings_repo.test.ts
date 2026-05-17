import {
  getSettings,
  saveSettings,
  type SettingsRepoEsClient,
  type SettingsRepoWriteEsClient,
} from '../settings_repo';
import { SETTINGS_DEFAULTS } from '../../../common/schemas/settings';
import { SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';
import { MissingIndexError } from '../../errors';

interface FakeOpts {
  indexExists?: boolean;
  doc?: Record<string, unknown> | null;
  getThrows?: unknown;
}

function makeClient(opts: FakeOpts = {}): SettingsRepoEsClient {
  return {
    indices: {
      exists: async ({ index }) => {
        expect(index).toBe(STATUS_INDEX);
        return opts.indexExists ?? true;
      },
    },
    get: async ({ index, id }) => {
      expect(index).toBe(STATUS_INDEX);
      expect(id).toBe(SETTINGS_ID);
      if (opts.getThrows) {
        throw opts.getThrows;
      }
      if (opts.doc === null) {
        return { found: false };
      }
      return { _source: opts.doc, found: true };
    },
  };
}

describe('getSettings', () => {
  it('throws MissingIndexError when the status index is absent', async () => {
    const client = makeClient({ indexExists: false });
    await expect(getSettings(client)).rejects.toBeInstanceOf(MissingIndexError);
  });

  it('returns null when ES throws a 404 (NotFoundError)', async () => {
    const client = makeClient({ getThrows: { statusCode: 404 } });
    await expect(getSettings(client)).resolves.toBeNull();
  });

  it('returns null when the document is reported missing without throwing', async () => {
    const client = makeClient({ doc: null });
    await expect(getSettings(client)).resolves.toBeNull();
  });

  it('returns a fully-populated SettingsDoc and drops the doctype field', async () => {
    const stored = {
      doctype: 'settings',
      repo_name_prefix: 'mycorp-deepfreeze',
      provider: 'aws',
      storage_class: 'glacier',
      last_suffix: '000042',
    };
    const client = makeClient({ doc: stored });

    const settings = await getSettings(client);

    expect(settings).not.toBeNull();
    // Stored fields preserved
    expect(settings!.repo_name_prefix).toBe('mycorp-deepfreeze');
    expect(settings!.last_suffix).toBe('000042');
    expect(settings!.storage_class).toBe('glacier');
    // Missing fields filled from defaults
    expect(settings!.bucket_name_prefix).toBe(SETTINGS_DEFAULTS.bucket_name_prefix);
    expect(settings!.thaw_request_retention_days_completed).toBe(
      SETTINGS_DEFAULTS.thaw_request_retention_days_completed
    );
    // Doctype always restored, never read from the source
    expect(settings!.doctype).toBe('settings');
  });

  it('propagates non-404 errors from get()', async () => {
    const client = makeClient({ getThrows: new Error('connection-refused') });
    await expect(getSettings(client)).rejects.toThrow('connection-refused');
  });
});

describe('saveSettings', () => {
  it('PUTs the settings document at the singleton id with doctype: settings', async () => {
    const captured: Record<string, unknown>[] = [];
    const client: SettingsRepoWriteEsClient = {
      indices: { exists: async () => true },
      get: async () => ({ found: true }),
      index: async (args) => {
        captured.push(args);
        return {};
      },
    };

    const settings = { ...SETTINGS_DEFAULTS, repo_name_prefix: 'mycorp', last_suffix: '000001' };
    await saveSettings(client, settings);

    expect(captured).toEqual([
      {
        index: STATUS_INDEX,
        id: SETTINGS_ID,
        document: { ...settings, doctype: 'settings' },
        refresh: 'wait_for',
      },
    ]);
  });

  it('forces doctype to "settings" even if the caller passed something else', async () => {
    const captured: Record<string, unknown>[] = [];
    const client: SettingsRepoWriteEsClient = {
      indices: { exists: async () => true },
      get: async () => ({ found: true }),
      index: async (args) => {
        captured.push(args);
        return {};
      },
    };

    const bogus = { ...SETTINGS_DEFAULTS, doctype: 'wrong' as 'settings' };
    await saveSettings(client, bogus);

    expect((captured[0].document as Record<string, unknown>).doctype).toBe('settings');
  });
});
