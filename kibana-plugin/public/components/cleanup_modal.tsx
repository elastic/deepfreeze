import React, { useCallback, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFieldNumber,
  EuiForm,
  EuiFormRow,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import { StepList } from './step_list';
import type { CleanupResult } from '../../server/actions/cleanup';

interface CleanupModalProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  onClose: () => void;
  onComplete: () => void;
}

interface ApiError {
  body?: { message?: string };
  message?: string;
}

function extractErrorMessage(err: unknown): string {
  const e = err as ApiError;
  return e?.body?.message ?? e?.message ?? 'Unknown error';
}

export function CleanupModal({ http, notifications, onClose, onComplete }: CleanupModalProps) {
  const [completedOverride, setCompletedOverride] = useState('');
  const [failedOverride, setFailedOverride] = useState('');
  const [refrozenOverride, setRefrozenOverride] = useState('');
  const [preview, setPreview] = useState<CleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const buildBody = useCallback(
    (dry: boolean) => {
      const body: Record<string, unknown> = { dry_run: dry };
      if (completedOverride.trim())
        body.retention_days_completed = Number(completedOverride);
      if (failedOverride.trim()) body.retention_days_failed = Number(failedOverride);
      if (refrozenOverride.trim())
        body.retention_days_refrozen = Number(refrozenOverride);
      return JSON.stringify(body);
    },
    [completedOverride, failedOverride, refrozenOverride]
  );

  const doPreview = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await http.post<CleanupResult>(API.cleanup, { body: buildBody(true) });
      setPreview(result);
    } catch (err) {
      setError(extractErrorMessage(err));
      setPreview(null);
    } finally {
      setRunning(false);
    }
  }, [http, buildBody]);

  const doRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await http.post<CleanupResult>(API.cleanup, { body: buildBody(false) });
      notifications.toasts.addSuccess({
        title: 'Cleanup completed',
        text:
          `Deleted ${result.deleted_thaw_requests.length} thaw request(s), ` +
          `archived ${result.expired_repositories.length} expired repo(s), ` +
          `reaped ${result.deleted_policies.length} orphaned ILM policy(ies).` +
          (result.errors.length ? ` ${result.errors.length} warning(s).` : ''),
      });
      onComplete();
      onClose();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      notifications.toasts.addDanger({ title: 'Cleanup failed', text: msg });
    } finally {
      setRunning(false);
    }
  }, [http, buildBody, notifications, onComplete, onClose]);

  return (
    <EuiModal onClose={onClose} maxWidth={640}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>Clean up expired state</EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiText size="s" color="subdued">
          <p>
            Deletes thaw-request documents past their retention window and unmounts repositories
            whose S3 restore window has expired. Retention defaults come from settings; the fields
            below are one-off overrides.
          </p>
        </EuiText>
        <EuiSpacer size="m" />
        <EuiForm component="div">
          <EuiFormRow
            label="Completed retention (days)"
            helpText="Override settings.thaw_request_retention_days_completed. Blank = use default."
          >
            <EuiFieldNumber
              min={0}
              max={36500}
              value={completedOverride}
              onChange={(e) => setCompletedOverride(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow label="Failed retention (days)">
            <EuiFieldNumber
              min={0}
              max={36500}
              value={failedOverride}
              onChange={(e) => setFailedOverride(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow label="Refrozen retention (days)">
            <EuiFieldNumber
              min={0}
              max={36500}
              value={refrozenOverride}
              onChange={(e) => setRefrozenOverride(e.target.value)}
            />
          </EuiFormRow>
        </EuiForm>

        {error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="danger" iconType="alert" title="Cleanup failed">
              <p>{error}</p>
            </EuiCallOut>
          </>
        )}

        {preview && !error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut
              color={preview.steps.length === 0 ? 'primary' : 'success'}
              iconType={preview.steps.length === 0 ? 'iInCircle' : 'check'}
              title={preview.steps.length === 0 ? 'Nothing to do' : 'Preview'}
            >
              {preview.steps.length === 0 ? (
                <p>No thaw requests or repositories are past their retention windows.</p>
              ) : (
                <>
                  <p>
                    Will delete {preview.deleted_thaw_requests.length} thaw request(s) and archive{' '}
                    {preview.expired_repositories.length} expired repo(s).
                  </p>
                  <StepList steps={preview.steps} />
                </>
              )}
            </EuiCallOut>
          </>
        )}
      </EuiModalBody>
      <EuiModalFooter>
        <EuiButtonEmpty onClick={onClose} isDisabled={running}>
          Cancel
        </EuiButtonEmpty>
        <EuiButton onClick={doPreview} iconType="inspect" isLoading={running}>
          Preview
        </EuiButton>
        <EuiButton fill onClick={doRun} iconType="play" isLoading={running} isDisabled={running}>
          Run cleanup
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}
