import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCode,
  EuiComboBox,
  type EuiComboBoxOptionOption,
  EuiDescriptionList,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiForm,
  EuiFormRow,
  EuiHorizontalRule,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiSteps,
  type EuiStepStatus,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import type { SetupConfig, SetupResult } from '../../server/actions/setup';

interface SetupWizardProps {
  http: CoreStart['http'];
  /** Called after a successful real run so the host page can refresh status. */
  onComplete: () => void;
}

interface SetupOptionsResponse {
  buckets_in_use: string[];
}

const BASE_PATH_REQUIRED_PREFIX = 'deepfreeze/';

const PROVIDER_OPTIONS = [
  { value: 'aws', text: 'Amazon S3 (aws)' },
  { value: 'azure', text: 'Azure Blob Storage (azure)' },
  { value: 'gcp', text: 'Google Cloud Storage (gcp)' },
] as const;

const STYLE_OPTIONS = [
  { value: 'oneup', text: 'Numeric counter (000001, 000002, ...)' },
  { value: 'date', text: 'Year.Month (YYYY.MM)' },
] as const;

// AWS-only; ignored for azure / gcp. Source: ES S3 repository plugin docs.
const CANNED_ACL_OPTIONS = [
  { value: 'private', text: 'private' },
  { value: 'public-read', text: 'public-read' },
  { value: 'public-read-write', text: 'public-read-write' },
  { value: 'authenticated-read', text: 'authenticated-read' },
  { value: 'log-delivery-write', text: 'log-delivery-write' },
  { value: 'bucket-owner-read', text: 'bucket-owner-read' },
  { value: 'bucket-owner-full-control', text: 'bucket-owner-full-control' },
];

const STORAGE_CLASS_OPTIONS = [
  { value: 'standard', text: 'standard' },
  { value: 'reduced_redundancy', text: 'reduced_redundancy' },
  { value: 'standard_ia', text: 'standard_ia' },
  { value: 'onezone_ia', text: 'onezone_ia' },
  { value: 'intelligent_tiering', text: 'intelligent_tiering' },
];

interface FormState {
  provider: 'aws' | 'azure' | 'gcp';
  style: 'oneup' | 'date';
  year: string;
  month: string;
  repo_name_prefix: string;
  bucket_name_prefix: string;
  base_path_suffix: string;
  canned_acl: string;
  storage_class: string;
  ilm_policy_name: string;
  index_template_name: string;
}

const INITIAL_FORM: FormState = {
  provider: 'aws',
  style: 'oneup',
  year: String(new Date().getUTCFullYear()),
  month: String(new Date().getUTCMonth() + 1),
  repo_name_prefix: 'deepfreeze',
  bucket_name_prefix: '',
  base_path_suffix: 'snapshots',
  canned_acl: 'private',
  storage_class: 'intelligent_tiering',
  ilm_policy_name: '',
  index_template_name: '',
};

interface PreconditionFailure {
  message: string;
  issues: string[];
}

interface ApiErrorAttributes {
  attributes?: { issues?: string[] };
}

function formToConfig(form: FormState): SetupConfig {
  return {
    repo_name_prefix: form.repo_name_prefix.trim(),
    bucket_name_prefix: form.bucket_name_prefix.trim(),
    base_path_prefix: `${BASE_PATH_REQUIRED_PREFIX}${form.base_path_suffix.trim()}`,
    canned_acl: form.canned_acl,
    storage_class: form.storage_class,
    provider: form.provider,
    // Path within a shared bucket is the only rotation strategy exposed by
    // the wizard right now; the server still accepts 'bucket' if called
    // directly, but the UI doesn't offer it.
    rotate_by: 'path',
    style: form.style,
    ...(form.style === 'date'
      ? { year: Number(form.year), month: Number(form.month) }
      : {}),
    ...(form.ilm_policy_name.trim()
      ? { ilm_policy_name: form.ilm_policy_name.trim() }
      : {}),
    ...(form.index_template_name.trim()
      ? { index_template_name: form.index_template_name.trim() }
      : {}),
  };
}

export function SetupWizard({ http, onComplete }: SetupWizardProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [stepIndex, setStepIndex] = useState(0);
  const [options, setOptions] = useState<SetupOptionsResponse | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [dryRunResult, setDryRunResult] = useState<SetupResult | null>(null);
  const [submitResult, setSubmitResult] = useState<SetupResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<PreconditionFailure | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFailure(null);
    setFatalError(null);
    setDryRunResult(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    http
      .get<SetupOptionsResponse>(API.setupOptions)
      .then((r) => {
        if (!cancelled) setOptions(r);
      })
      .catch((e: Error) => {
        if (!cancelled) setOptionsError(e.message);
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [http]);

  const step1Valid = form.style !== 'date' || (Number(form.year) > 0 && Number(form.month) >= 1 && Number(form.month) <= 12);
  const step2Valid =
    form.repo_name_prefix.trim().length > 0 &&
    form.bucket_name_prefix.trim().length > 0 &&
    form.base_path_suffix.trim().length > 0;
  const step3Valid = form.provider !== 'aws' || (form.canned_acl.length > 0 && form.storage_class.length > 0);

  const stepStatuses: EuiStepStatus[] = [
    step1Valid ? (stepIndex > 0 ? 'complete' : 'current') : stepIndex === 0 ? 'current' : 'incomplete',
    stepIndex < 1 ? 'incomplete' : step2Valid ? (stepIndex > 1 ? 'complete' : 'current') : 'current',
    stepIndex < 2 ? 'incomplete' : step3Valid ? (stepIndex > 2 ? 'complete' : 'current') : 'current',
    stepIndex < 3 ? 'incomplete' : stepIndex > 3 ? 'complete' : 'current',
    stepIndex < 4 ? 'incomplete' : submitResult ? 'complete' : 'current',
  ];

  const callDryRun = useCallback(async () => {
    setRunning(true);
    setFailure(null);
    setFatalError(null);
    setDryRunResult(null);
    try {
      const result = await http.post<SetupResult>(API.setupDryRun, {
        body: JSON.stringify(formToConfig(form)),
      });
      setDryRunResult(result);
    } catch (err) {
      handleApiError(err, setFailure, setFatalError);
    } finally {
      setRunning(false);
    }
  }, [http, form]);

  const callSubmit = useCallback(async () => {
    setRunning(true);
    setFailure(null);
    setFatalError(null);
    try {
      const result = await http.post<SetupResult>(API.setup, {
        body: JSON.stringify(formToConfig(form)),
      });
      setSubmitResult(result);
    } catch (err) {
      handleApiError(err, setFailure, setFatalError);
    } finally {
      setRunning(false);
    }
  }, [http, form]);

  if (optionsLoading) {
    return (
      <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 200 }}>
        <EuiFlexItem grow={false}>
          <EuiLoadingSpinner size="xl" />
        </EuiFlexItem>
      </EuiFlexGroup>
    );
  }

  if (optionsError) {
    return (
      <EuiCallOut title="Could not load setup options" color="danger" iconType="alert">
        <p>{optionsError}</p>
      </EuiCallOut>
    );
  }

  if (submitResult) {
    return <CompletionPanel result={submitResult} onComplete={onComplete} />;
  }

  const buckets = options?.buckets_in_use ?? [];

  return (
    <EuiPanel hasBorder paddingSize="l">
      <EuiTitle size="m">
        <h2>Set up deepfreeze</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      <EuiText color="subdued" size="s">
        <p>
          Deepfreeze does not create cloud buckets. Pick a bucket already in use by another snapshot
          repository, then choose where on it deepfreeze should store its snapshots. The base path
          is always rooted at <EuiCode>{BASE_PATH_REQUIRED_PREFIX}</EuiCode>.
        </p>
      </EuiText>

      <EuiSpacer size="l" />

      <EuiSteps
        headingElement="h3"
        steps={[
          {
            title: 'Provider and rotation strategy',
            status: stepStatuses[0],
            children:
              stepIndex === 0 ? (
                <Step1ProviderRotation form={form} update={update} />
              ) : null,
          },
          {
            title: 'Repository name and storage location',
            status: stepStatuses[1],
            children:
              stepIndex === 1 ? (
                <Step2Naming
                  form={form}
                  update={update}
                  buckets={buckets}
                />
              ) : null,
          },
          {
            title: form.provider === 'aws' ? 'S3 ACL and storage class' : 'Storage details',
            status: stepStatuses[2],
            children:
              stepIndex === 2 ? (
                <Step3StorageDetails form={form} update={update} />
              ) : null,
          },
          {
            title: 'Optional ILM policy and index template',
            status: stepStatuses[3],
            children: stepIndex === 3 ? <Step4Ilm form={form} update={update} /> : null,
          },
          {
            title: 'Review and run',
            status: stepStatuses[4],
            children:
              stepIndex === 4 ? (
                <Step5Review
                  form={form}
                  dryRunResult={dryRunResult}
                  failure={failure}
                  fatalError={fatalError}
                  running={running}
                  onDryRun={callDryRun}
                  onSubmit={callSubmit}
                />
              ) : null,
          },
        ]}
      />

      <EuiHorizontalRule />

      <EuiFlexGroup justifyContent="spaceBetween">
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty
            iconType="arrowLeft"
            isDisabled={stepIndex === 0 || running}
            onClick={() => setStepIndex(stepIndex - 1)}
          >
            Back
          </EuiButtonEmpty>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          {stepIndex < 4 ? (
            <EuiButton
              iconType="arrowRight"
              iconSide="right"
              fill
              isDisabled={
                running ||
                (stepIndex === 0 && !step1Valid) ||
                (stepIndex === 1 && !step2Valid) ||
                (stepIndex === 2 && !step3Valid)
              }
              onClick={() => setStepIndex(stepIndex + 1)}
            >
              Next
            </EuiButton>
          ) : null}
        </EuiFlexItem>
      </EuiFlexGroup>
    </EuiPanel>
  );
}

// -- Step 1 ----------------------------------------------------------------

function Step1ProviderRotation({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <EuiForm component="div">
      <EuiFormRow label="Provider" helpText="Choose the cloud provider hosting your buckets.">
        <EuiSelect
          options={[...PROVIDER_OPTIONS]}
          value={form.provider}
          onChange={(e) => update('provider', e.target.value as FormState['provider'])}
        />
      </EuiFormRow>
      <EuiFormRow
        label="Suffix style"
        helpText="How rotated repositories are named: 000001/000002/… or 2026.05/2026.06/…"
      >
        <EuiSelect
          options={[...STYLE_OPTIONS]}
          value={form.style}
          onChange={(e) => update('style', e.target.value as FormState['style'])}
        />
      </EuiFormRow>
      {form.style === 'date' && (
        <EuiFlexGroup>
          <EuiFlexItem>
            <EuiFormRow label="Year">
              <EuiFieldNumber
                min={1900}
                max={9999}
                value={form.year}
                onChange={(e) => update('year', e.target.value)}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Month">
              <EuiFieldNumber
                min={1}
                max={12}
                value={form.month}
                onChange={(e) => update('month', e.target.value)}
              />
            </EuiFormRow>
          </EuiFlexItem>
        </EuiFlexGroup>
      )}
    </EuiForm>
  );
}

// -- Step 2 ----------------------------------------------------------------

function Step2Naming({
  form,
  update,
  buckets,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  buckets: string[];
}) {
  const bucketOptions: EuiComboBoxOptionOption<string>[] = useMemo(
    () => buckets.map((b) => ({ label: b, value: b })),
    [buckets]
  );
  const selectedBucket: EuiComboBoxOptionOption<string>[] = form.bucket_name_prefix
    ? [{ label: form.bucket_name_prefix, value: form.bucket_name_prefix }]
    : [];

  return (
    <EuiForm component="div">
      <EuiFormRow
        label="Repository name prefix"
        helpText={`Will be suffixed with the rotation key (e.g. "${form.repo_name_prefix || 'deepfreeze'}-000001").`}
      >
        <EuiFieldText
          value={form.repo_name_prefix}
          onChange={(e) => update('repo_name_prefix', e.target.value)}
        />
      </EuiFormRow>

      {buckets.length === 0 ? (
        <EuiCallOut
          color="warning"
          iconType="warning"
          title="No buckets available"
          size="s"
        >
          <p>
            This cluster has no cloud-backed snapshot repositories. Configure at least one bucket
            via Stack Management → Snapshot and Restore, then return to deepfreeze setup.
          </p>
        </EuiCallOut>
      ) : (
        <EuiFormRow
          label="Bucket"
          helpText="Pick from buckets already in use by an ES snapshot repository on this cluster."
        >
          <EuiComboBox<string>
            singleSelection={{ asPlainText: true }}
            options={bucketOptions}
            selectedOptions={selectedBucket}
            onChange={(sel) => update('bucket_name_prefix', sel[0]?.value ?? '')}
            isClearable={false}
          />
        </EuiFormRow>
      )}

      <EuiFormRow
        label="Base path"
        helpText={`Stored as ${BASE_PATH_REQUIRED_PREFIX}<your-input>. The rotation suffix is appended automatically.`}
      >
        <EuiFieldText
          prepend={BASE_PATH_REQUIRED_PREFIX}
          value={form.base_path_suffix}
          onChange={(e) =>
            update(
              'base_path_suffix',
              // strip an accidentally-typed-in prefix so the rendered prepend stays accurate
              e.target.value.replace(new RegExp(`^${BASE_PATH_REQUIRED_PREFIX}`), '')
            )
          }
        />
      </EuiFormRow>
    </EuiForm>
  );
}

// -- Step 3 ----------------------------------------------------------------

function Step3StorageDetails({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  if (form.provider !== 'aws') {
    return (
      <EuiText color="subdued" size="s">
        <p>
          No additional storage settings required for {form.provider}. Snapshot lifecycle rules are
          managed at the storage account / bucket level.
        </p>
      </EuiText>
    );
  }

  return (
    <EuiForm component="div">
      <EuiFormRow
        label="Canned ACL"
        helpText="S3 access control list applied to objects in this repository."
      >
        <EuiSelect
          options={CANNED_ACL_OPTIONS}
          value={form.canned_acl}
          onChange={(e) => update('canned_acl', e.target.value)}
        />
      </EuiFormRow>
      <EuiFormRow label="Storage class" helpText="S3 storage class for snapshot objects.">
        <EuiSelect
          options={STORAGE_CLASS_OPTIONS}
          value={form.storage_class}
          onChange={(e) => update('storage_class', e.target.value)}
        />
      </EuiFormRow>
    </EuiForm>
  );
}

// -- Step 4 ----------------------------------------------------------------

function Step4Ilm({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <EuiForm component="div">
      <EuiText size="s" color="subdued">
        <p>
          Both fields are optional. Leave blank to skip ILM and template configuration; you can wire
          them up later via Kibana&apos;s ILM and Index Management apps.
        </p>
      </EuiText>
      <EuiSpacer size="s" />
      <EuiFormRow
        label="ILM policy name"
        helpText="Created with a default Hot → Cold → Frozen → Delete tiering strategy if missing; otherwise retargeted to the new deepfreeze repository."
      >
        <EuiFieldText
          value={form.ilm_policy_name}
          onChange={(e) => update('ilm_policy_name', e.target.value)}
        />
      </EuiFormRow>
      <EuiFormRow
        label="Index template name"
        helpText="If set, the template's index.lifecycle.name is rewritten to the ILM policy above. Requires ILM policy name."
        isDisabled={form.ilm_policy_name.trim().length === 0}
      >
        <EuiFieldText
          value={form.index_template_name}
          onChange={(e) => update('index_template_name', e.target.value)}
          disabled={form.ilm_policy_name.trim().length === 0}
        />
      </EuiFormRow>
    </EuiForm>
  );
}

// -- Step 5 ----------------------------------------------------------------

function Step5Review({
  form,
  dryRunResult,
  failure,
  fatalError,
  running,
  onDryRun,
  onSubmit,
}: {
  form: FormState;
  dryRunResult: SetupResult | null;
  failure: PreconditionFailure | null;
  fatalError: string | null;
  running: boolean;
  onDryRun: () => void;
  onSubmit: () => void;
}) {
  const summary = [
    { title: 'Provider', description: form.provider },
    { title: 'Suffix style', description: form.style },
    ...(form.style === 'date'
      ? [{ title: 'Year / Month', description: `${form.year} / ${form.month}` }]
      : []),
    { title: 'Repository name prefix', description: form.repo_name_prefix },
    { title: 'Bucket', description: form.bucket_name_prefix },
    {
      title: 'Base path prefix',
      description: `${BASE_PATH_REQUIRED_PREFIX}${form.base_path_suffix}`,
    },
    ...(form.provider === 'aws'
      ? [
          { title: 'Canned ACL', description: form.canned_acl },
          { title: 'Storage class', description: form.storage_class },
        ]
      : []),
    {
      title: 'ILM policy',
      description: form.ilm_policy_name.trim() || '(skip)',
    },
    {
      title: 'Index template',
      description: form.index_template_name.trim() || '(skip)',
    },
  ];

  return (
    <>
      <EuiDescriptionList type="column" compressed listItems={summary} />

      <EuiSpacer size="m" />

      <EuiFlexGroup gutterSize="s">
        <EuiFlexItem grow={false}>
          <EuiButton onClick={onDryRun} isLoading={running} iconType="inspect">
            Dry-run
          </EuiButton>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton
            fill
            color="primary"
            iconType="play"
            onClick={onSubmit}
            isLoading={running}
            isDisabled={running || dryRunResult === null}
          >
            Run setup
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {failure && (
        <EuiCallOut color="danger" iconType="alert" title={failure.message}>
          <ul>
            {failure.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </EuiCallOut>
      )}

      {fatalError && !failure && (
        <EuiCallOut color="danger" iconType="alert" title="Setup request failed">
          <p>{fatalError}</p>
        </EuiCallOut>
      )}

      {dryRunResult && !failure && (
        <EuiCallOut color="success" iconType="check" title="Dry-run succeeded">
          <p>The following steps will execute when you run setup:</p>
          <ul>
            {dryRunResult.steps.map((s, i) => (
              <li key={i}>
                <EuiCode>{s.type}</EuiCode> — {s.action}
                {s.name ? ` (${s.name})` : ''}
                {s.detail ? ` — ${s.detail}` : ''}
              </li>
            ))}
          </ul>
        </EuiCallOut>
      )}
    </>
  );
}

// -- Completion ------------------------------------------------------------

function CompletionPanel({
  result,
  onComplete,
}: {
  result: SetupResult;
  onComplete: () => void;
}) {
  return (
    <EuiPanel hasBorder paddingSize="l">
      <EuiCallOut color="success" iconType="check" title="Deepfreeze is initialized">
        <EuiDescriptionList
          type="column"
          compressed
          listItems={[
            { title: 'Repository', description: result.new_repo_name },
            { title: 'Bucket', description: result.new_bucket },
            { title: 'Base path', description: result.new_base_path },
          ]}
        />
        {result.errors.length > 0 && (
          <>
            <EuiSpacer size="s" />
            <strong>Warnings:</strong>
            <ul>
              {result.errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </>
        )}
        <EuiSpacer size="s" />
        <EuiButton color="success" fill onClick={onComplete}>
          Continue to Overview
        </EuiButton>
      </EuiCallOut>
    </EuiPanel>
  );
}

// -- Error parsing ---------------------------------------------------------

/**
 * The Kibana http service raises an Error whose `body` is the parsed
 * response payload. PreconditionError responses come back as 400 with
 * `attributes: { issues: string[] }` — surface those as a structured
 * failure; everything else as a generic fatal error.
 */
function handleApiError(
  err: unknown,
  setFailure: (f: PreconditionFailure) => void,
  setFatalError: (msg: string) => void
) {
  const e = err as { body?: ApiErrorAttributes; message?: string };
  const issues = e?.body?.attributes?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    setFailure({
      message: e.message ?? 'Preconditions failed',
      issues,
    });
    return;
  }
  setFatalError(e?.message ?? 'Unknown error');
}
