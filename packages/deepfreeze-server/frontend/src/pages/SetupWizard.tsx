import { useCallback, useEffect, useMemo, useState } from 'react';
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
  EuiRadioGroup,
  EuiSelect,
  EuiSpacer,
  EuiSteps,
  type EuiStepStatus,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import {
  api,
  type CommandResult,
  type SetupConfig,
  type SetupOptions,
} from '../api/client';

interface SetupWizardProps {
  /** Called after a successful real run so the host page can refresh status. */
  onComplete: () => void;
}

/** A single step record extracted from the server's CommandResult.details. */
interface StepDetail {
  type: string;
  action: string;
  target?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown>;
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

type BucketMode = 'reuse' | 'create';

interface FormState {
  provider: 'aws' | 'azure' | 'gcp';
  style: 'oneup' | 'date';
  year: string;
  month: string;
  repo_name_prefix: string;
  bucket_mode: BucketMode;
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
  bucket_mode: 'reuse',
  bucket_name_prefix: '',
  base_path_suffix: 'snapshots',
  canned_acl: 'private',
  storage_class: 'standard',
  ilm_policy_name: '',
  index_template_name: '',
};

function formToConfig(form: FormState): SetupConfig {
  return {
    repo_name_prefix: form.repo_name_prefix.trim(),
    bucket_name_prefix: form.bucket_name_prefix.trim(),
    base_path_prefix: `${BASE_PATH_REQUIRED_PREFIX}${form.base_path_suffix.trim()}`,
    canned_acl: form.canned_acl,
    storage_class: form.storage_class,
    provider: form.provider,
    // Path within a shared bucket is the only rotation strategy the wizard
    // exposes right now; the server still accepts 'bucket' if called directly.
    rotate_by: 'path',
    style: form.style,
    // 'reuse' → don't create the bucket; 'create' → provision it.
    create_bucket: form.bucket_mode === 'create',
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

function resultSteps(result: CommandResult): StepDetail[] {
  return (result.details as unknown as StepDetail[]) ?? [];
}

function resultErrors(result: CommandResult): string[] {
  return (result.errors ?? []).map((e) => {
    if (e && typeof e === 'object' && 'message' in e) {
      return String((e as { message: unknown }).message);
    }
    return String(e);
  });
}

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [stepIndex, setStepIndex] = useState(0);
  const [options, setOptions] = useState<SetupOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [dryRunResult, setDryRunResult] = useState<CommandResult | null>(null);
  const [submitResult, setSubmitResult] = useState<CommandResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failureIssues, setFailureIssues] = useState<string[] | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFailureIssues(null);
    setFatalError(null);
    setDryRunResult(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getSetupOptions()
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
  }, []);

  const step1Valid =
    form.style !== 'date' ||
    (Number(form.year) > 0 && Number(form.month) >= 1 && Number(form.month) <= 12);
  const step2Valid =
    form.repo_name_prefix.trim().length > 0 &&
    form.bucket_name_prefix.trim().length > 0 &&
    form.base_path_suffix.trim().length > 0;
  const step3Valid =
    form.provider !== 'aws' || (form.canned_acl.length > 0 && form.storage_class.length > 0);

  const stepStatuses: EuiStepStatus[] = [
    step1Valid ? (stepIndex > 0 ? 'complete' : 'current') : stepIndex === 0 ? 'current' : 'incomplete',
    stepIndex < 1 ? 'incomplete' : step2Valid ? (stepIndex > 1 ? 'complete' : 'current') : 'current',
    stepIndex < 2 ? 'incomplete' : step3Valid ? (stepIndex > 2 ? 'complete' : 'current') : 'current',
    stepIndex < 3 ? 'incomplete' : stepIndex > 3 ? 'complete' : 'current',
    stepIndex < 4 ? 'incomplete' : submitResult ? 'complete' : 'current',
  ];

  const applyResult = useCallback((result: CommandResult, setOk: (r: CommandResult) => void) => {
    if (result.success) {
      setOk(result);
    } else {
      const issues = resultErrors(result);
      setFailureIssues(issues.length > 0 ? issues : [result.summary || 'Setup preconditions failed']);
    }
  }, []);

  const callDryRun = useCallback(async () => {
    setRunning(true);
    setFailureIssues(null);
    setFatalError(null);
    setDryRunResult(null);
    try {
      const result = await api.setupDryRun(formToConfig(form));
      applyResult(result, setDryRunResult);
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  }, [form, applyResult]);

  const callSubmit = useCallback(async () => {
    setRunning(true);
    setFailureIssues(null);
    setFatalError(null);
    try {
      const result = await api.setup(formToConfig(form));
      applyResult(result, setSubmitResult);
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  }, [form, applyResult]);

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
          Choose where deepfreeze stores its snapshots. You can reuse a bucket already backing an
          existing snapshot repository, or have deepfreeze create a new one. The base path is always
          rooted at <EuiCode>{BASE_PATH_REQUIRED_PREFIX}</EuiCode>.
        </p>
      </EuiText>

      <EuiSpacer size="l" />

      <EuiSteps
        headingElement="h3"
        steps={[
          {
            title: 'Provider and rotation strategy',
            status: stepStatuses[0],
            children: stepIndex === 0 ? <Step1ProviderRotation form={form} update={update} /> : <></>,
          },
          {
            title: 'Repository name and storage location',
            status: stepStatuses[1],
            children:
              stepIndex === 1 ? <Step2Naming form={form} update={update} buckets={buckets} /> : <></>,
          },
          {
            title: form.provider === 'aws' ? 'S3 ACL and storage class' : 'Storage details',
            status: stepStatuses[2],
            children:
              stepIndex === 2 ? (
                <Step3StorageDetails
                  form={form}
                  update={update}
                  s3ClientNames={options?.s3_client_names ?? []}
                />
              ) : (
                <></>
              ),
          },
          {
            title: 'Optional ILM policy and index template',
            status: stepStatuses[3],
            children:
              stepIndex === 3 ? (
                <Step4Ilm
                  form={form}
                  update={update}
                  ilmPolicyNames={options?.ilm_policy_names ?? []}
                  indexTemplateNames={options?.index_template_names ?? []}
                />
              ) : (
                <></>
              ),
          },
          {
            title: 'Review and run',
            status: stepStatuses[4],
            children:
              stepIndex === 4 ? (
                <Step5Review
                  form={form}
                  dryRunResult={dryRunResult}
                  failureIssues={failureIssues}
                  fatalError={fatalError}
                  running={running}
                  onDryRun={callDryRun}
                  onSubmit={callSubmit}
                />
              ) : (
                <></>
              ),
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

  const noBuckets = buckets.length === 0;

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

      <EuiFormRow label="Bucket" helpText="Reuse a bucket already in use, or create a new one.">
        <EuiRadioGroup
          options={[
            { id: 'reuse', label: 'Reuse an existing bucket' },
            { id: 'create', label: 'Create a new bucket' },
          ]}
          idSelected={form.bucket_mode}
          onChange={(id) => {
            // Clear the bucket name when switching modes to avoid carrying a
            // picked value into a free-text field (or vice-versa).
            update('bucket_mode', id as BucketMode);
            update('bucket_name_prefix', '');
          }}
        />
      </EuiFormRow>

      {form.bucket_mode === 'reuse' ? (
        noBuckets ? (
          <EuiCallOut color="warning" iconType="warning" title="No buckets available" size="s">
            <p>
              This cluster has no cloud-backed snapshot repositories to reuse. Switch to{' '}
              <strong>Create a new bucket</strong> above, or configure a bucket via Kibana&apos;s
              Snapshot and Restore, then return here.
            </p>
          </EuiCallOut>
        ) : (
          <EuiFormRow
            label="Existing bucket"
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
        )
      ) : (
        <EuiFormRow
          label="New bucket name"
          helpText="Deepfreeze will create this bucket. It must not already exist."
        >
          <EuiFieldText
            value={form.bucket_name_prefix}
            onChange={(e) => update('bucket_name_prefix', e.target.value)}
            placeholder="my-deepfreeze-bucket"
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
  s3ClientNames,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  s3ClientNames: string[];
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
      <EuiSpacer size="m" />
      <KeystoreGuidanceCallout s3ClientNames={s3ClientNames} />
    </EuiForm>
  );
}

/**
 * Reminds the operator that ES uses its OWN keystore credentials
 * (`s3.client.<name>.{access_key,secret_key}`) to read/write the snapshot
 * repository, and that the deepfreeze server needs AWS credentials of its own
 * (config.yml, ambient AWS_* env vars, ~/.aws/credentials, or an instance
 * role) for the S3 calls it makes directly on thaw/refreeze. We surface the
 * client names ES reports so the operator knows which entries to mirror.
 */
function KeystoreGuidanceCallout({ s3ClientNames }: { s3ClientNames: string[] }) {
  return (
    <EuiCallOut
      color="primary"
      iconType="iInCircle"
      size="s"
      title="AWS credentials for deepfreeze's own S3 calls"
    >
      <EuiText size="s">
        <p>
          Elasticsearch stores its snapshot-repo credentials under{' '}
          <EuiCode>s3.client.&lt;name&gt;.access_key</EuiCode> /{' '}
          <EuiCode>s3.client.&lt;name&gt;.secret_key</EuiCode> in the ES keystore. The deepfreeze
          server can&apos;t read those — it needs its own AWS credentials for the S3 calls it makes
          directly (restore-on-thaw, tier sampling).
        </p>
        {s3ClientNames.length > 0 && (
          <p>
            Detected ES S3 client name{s3ClientNames.length === 1 ? '' : 's'}:{' '}
            {s3ClientNames.map((n, i) => (
              <span key={n}>
                {i > 0 && ', '}
                <EuiCode>{n}</EuiCode>
              </span>
            ))}
            .
          </p>
        )}
        <p>
          Provide credentials to the deepfreeze server via its config, ambient{' '}
          <EuiCode>AWS_ACCESS_KEY_ID</EuiCode> / <EuiCode>AWS_SECRET_ACCESS_KEY</EuiCode>,{' '}
          <EuiCode>~/.aws/credentials</EuiCode>, or an attached EC2/ECS instance role.
        </p>
      </EuiText>
    </EuiCallOut>
  );
}

// -- Step 4 ----------------------------------------------------------------

function Step4Ilm({
  form,
  update,
  ilmPolicyNames,
  indexTemplateNames,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  ilmPolicyNames: string[];
  indexTemplateNames: string[];
}) {
  const ilmOptions: EuiComboBoxOptionOption<string>[] = useMemo(
    () => ilmPolicyNames.map((n) => ({ label: n, value: n })),
    [ilmPolicyNames]
  );
  const selectedIlm: EuiComboBoxOptionOption<string>[] = form.ilm_policy_name.trim()
    ? [{ label: form.ilm_policy_name, value: form.ilm_policy_name }]
    : [];

  const templateOptions: EuiComboBoxOptionOption<string>[] = useMemo(
    () => indexTemplateNames.map((n) => ({ label: n, value: n })),
    [indexTemplateNames]
  );
  const selectedTemplate: EuiComboBoxOptionOption<string>[] = form.index_template_name.trim()
    ? [{ label: form.index_template_name, value: form.index_template_name }]
    : [];

  const ilmDisabled = form.ilm_policy_name.trim().length === 0;
  const noTemplatesOnCluster = indexTemplateNames.length === 0;

  return (
    <EuiForm component="div">
      <EuiText size="s" color="subdued">
        <p>
          Both fields are optional. Leave blank to skip ILM and template configuration; you can wire
          them up later.
        </p>
      </EuiText>
      <EuiSpacer size="s" />
      <EuiFormRow
        label="ILM policy"
        helpText="Pick an existing policy or type a new name. New names get a default Hot → Cold → Frozen → Delete tiering strategy targeting the new repository."
      >
        <EuiComboBox<string>
          singleSelection={{ asPlainText: true }}
          options={ilmOptions}
          selectedOptions={selectedIlm}
          onChange={(sel) => update('ilm_policy_name', sel[0]?.value ?? '')}
          onCreateOption={(name) => update('ilm_policy_name', name.trim())}
          customOptionText="Create new policy {searchValue}"
          isClearable
          placeholder="Select a policy or type a new name"
        />
      </EuiFormRow>
      <EuiFormRow
        label="Index template"
        helpText="If set, the template's index.lifecycle.name is rewritten to the ILM policy. Only existing templates can be selected. Requires an ILM policy."
        isDisabled={ilmDisabled || noTemplatesOnCluster}
      >
        {noTemplatesOnCluster ? (
          <EuiCallOut color="warning" iconType="warning" size="s" title="No index templates on this cluster">
            <p>
              Create an index template first, or leave this blank — you can wire the template
              binding up later.
            </p>
          </EuiCallOut>
        ) : (
          <EuiComboBox<string>
            singleSelection={{ asPlainText: true }}
            options={templateOptions}
            selectedOptions={selectedTemplate}
            onChange={(sel) => update('index_template_name', sel[0]?.value ?? '')}
            isClearable
            isDisabled={ilmDisabled}
            placeholder="Select a template (optional)"
          />
        )}
      </EuiFormRow>
    </EuiForm>
  );
}

// -- Step 5 ----------------------------------------------------------------

function Step5Review({
  form,
  dryRunResult,
  failureIssues,
  fatalError,
  running,
  onDryRun,
  onSubmit,
}: {
  form: FormState;
  dryRunResult: CommandResult | null;
  failureIssues: string[] | null;
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
    {
      title: 'Bucket',
      description: `${form.bucket_name_prefix} (${form.bucket_mode === 'create' ? 'create new' : 'reuse existing'})`,
    },
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
    { title: 'ILM policy', description: form.ilm_policy_name.trim() || '(skip)' },
    { title: 'Index template', description: form.index_template_name.trim() || '(skip)' },
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
            isDisabled={running}
          >
            Run setup
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {failureIssues && (
        <EuiCallOut color="danger" iconType="alert" title="Setup preconditions failed">
          <ul>
            {failureIssues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </EuiCallOut>
      )}

      {fatalError && !failureIssues && (
        <EuiCallOut color="danger" iconType="alert" title="Setup request failed">
          <p>{fatalError}</p>
        </EuiCallOut>
      )}

      {dryRunResult && !failureIssues && (
        <EuiCallOut color="success" iconType="check" title="Dry-run succeeded">
          <p>The following steps will execute when you run setup:</p>
          <ul>
            {resultSteps(dryRunResult).map((s, i) => (
              <li key={i}>
                <EuiCode>{s.type}</EuiCode> — {s.action}
                {s.target ? ` (${s.target})` : ''}
                {s.metadata && typeof s.metadata.detail === 'string' ? ` — ${s.metadata.detail}` : ''}
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
  result: CommandResult;
  onComplete: () => void;
}) {
  const repoStep = resultSteps(result).find((s) => s.type === 'repository');
  const meta = repoStep?.metadata ?? {};
  const listItems = [
    { title: 'Repository', description: String(repoStep?.target ?? '--') },
    { title: 'Bucket', description: String(meta.bucket ?? '--') },
    { title: 'Base path', description: String(meta.base_path ?? '--') },
  ];
  const errors = resultErrors(result);

  return (
    <EuiPanel hasBorder paddingSize="l">
      <EuiCallOut color="success" iconType="check" title="Deepfreeze is initialized">
        <EuiDescriptionList type="column" compressed listItems={listItems} />
        {errors.length > 0 && (
          <>
            <EuiSpacer size="s" />
            <strong>Warnings:</strong>
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
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
