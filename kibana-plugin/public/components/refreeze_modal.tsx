import React, { useCallback, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCode,
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
import type { RefreezeResult } from '../../server/actions/refreeze';

interface RefreezeModalProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  request_id: string;
  /** Repos in the request, for display in the confirmation copy. */
  repo_names: string[];
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

export function RefreezeModal({
  http,
  notifications,
  request_id,
  repo_names,
  onClose,
  onComplete,
}: RefreezeModalProps) {
  const [preview, setPreview] = useState<RefreezeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const buildBody = useCallback(
    (dry: boolean) => JSON.stringify({ request_id, dry_run: dry }),
    [request_id]
  );

  const doPreview = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await http.post<RefreezeResult>(API.refreeze, { body: buildBody(true) });
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
      const result = await http.post<RefreezeResult>(API.refreeze, { body: buildBody(false) });
      if (result.refrozen_requests.includes(request_id)) {
        notifications.toasts.addSuccess({
          title: `Refrozen request ${request_id.slice(0, 8)}`,
          text:
            `${repo_names.length} repo(s) frozen.` +
            (result.errors.length ? ` ${result.errors.length} warning(s).` : ''),
        });
      } else {
        const reason = result.rejected_requests[0]?.reason ?? 'unknown reason';
        notifications.toasts.addWarning({
          title: `Refreeze of ${request_id.slice(0, 8)} did not complete`,
          text: reason,
        });
      }
      onComplete();
      onClose();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      notifications.toasts.addDanger({ title: 'Refreeze failed', text: msg });
    } finally {
      setRunning(false);
    }
  }, [http, buildBody, notifications, request_id, repo_names, onComplete, onClose]);

  return (
    <EuiModal onClose={onClose} maxWidth={640}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>
          Refreeze request <EuiCode>{request_id.slice(0, 8)}</EuiCode>
        </EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiText size="s" color="subdued">
          <p>
            Deletes the searchable-snapshot indices restored by this thaw request, unmounts the
            backing repositories, and marks the request as <strong>refrozen</strong>.
          </p>
          {repo_names.length > 0 && (
            <p>
              Affects {repo_names.length} repositor{repo_names.length === 1 ? 'y' : 'ies'}:{' '}
              {repo_names.map((n) => (
                <EuiCode key={n}>{n}</EuiCode>
              ))}
            </p>
          )}
        </EuiText>

        {error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="danger" iconType="alert" title="Refreeze failed">
              <p>{error}</p>
            </EuiCallOut>
          </>
        )}

        {preview && !error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="success" iconType="check" title="Preview">
              <p>
                Request{' '}
                {preview.refrozen_requests.includes(request_id)
                  ? 'will be refrozen.'
                  : `cannot be refrozen: ${
                      preview.rejected_requests[0]?.reason ?? 'unknown'
                    }`}
              </p>
              <StepList steps={preview.steps} />
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
        <EuiButton
          fill
          color="danger"
          onClick={doRun}
          iconType="snowflake"
          isLoading={running}
          isDisabled={!preview || !preview.refrozen_requests.includes(request_id)}
        >
          Refreeze
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}
