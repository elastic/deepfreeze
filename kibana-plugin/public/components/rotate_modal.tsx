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
import type { RotateResult } from '../../server/actions/rotate';

interface RotateModalProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  onClose: () => void;
  onComplete: () => void;
}

interface ApiError {
  body?: { message?: string; attributes?: { code?: string; issues?: string[] } };
  message?: string;
}

function extractErrorMessage(err: unknown): string {
  const e = err as ApiError;
  return e?.body?.message ?? e?.message ?? 'Unknown error';
}

export function RotateModal({ http, notifications, onClose, onComplete }: RotateModalProps) {
  // Default chosen to match the server-side DEFAULT_KEEP (6 months of
  // active repos for a typical monthly-rotation site).
  const [keep, setKeep] = useState('6');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [preview, setPreview] = useState<RotateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const buildBody = useCallback(
    (dry: boolean) => {
      const body: Record<string, unknown> = { dry_run: dry };
      const keepNum = Number(keep);
      if (Number.isFinite(keepNum) && keepNum >= 0) body.keep = keepNum;
      if (year.trim()) body.year = Number(year);
      if (month.trim()) body.month = Number(month);
      return JSON.stringify(body);
    },
    [keep, year, month]
  );

  const doPreview = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await http.post<RotateResult>(API.rotate, { body: buildBody(true) });
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
      const result = await http.post<RotateResult>(API.rotate, { body: buildBody(false) });
      const warningCount = result.errors.length;
      notifications.toasts.addSuccess({
        title: `Rotate completed: ${result.new_repo_name}`,
        text:
          `Archived ${result.archived.length} repo(s)` +
          (result.skipped.length ? `, skipped ${result.skipped.length}` : '') +
          (warningCount ? `, ${warningCount} warning(s)` : ''),
      });
      onComplete();
      onClose();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      notifications.toasts.addDanger({ title: 'Rotate failed', text: msg });
    } finally {
      setRunning(false);
    }
  }, [http, buildBody, notifications, onComplete, onClose]);

  return (
    <EuiModal onClose={onClose} maxWidth={640}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>Rotate to a new repository</EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiText size="s" color="subdued">
          <p>
            Creates a new snapshot repository with the next suffix, retargets the configured ILM
            policy (if any) at it, and unmounts active repositories beyond the <code>keep</code>{' '}
            window.
          </p>
        </EuiText>
        <EuiSpacer size="m" />
        <EuiForm component="div">
          <EuiFormRow label="Keep" helpText="Newest active repositories to keep mounted.">
            <EuiFieldNumber
              min={0}
              max={1000}
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow
            label="Year (date style only)"
            helpText="Leave blank to use the current year."
          >
            <EuiFieldNumber
              min={1900}
              max={9999}
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow
            label="Month (date style only)"
            helpText="Leave blank to use the current month."
          >
            <EuiFieldNumber
              min={1}
              max={12}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </EuiFormRow>
        </EuiForm>

        {error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="danger" iconType="alert" title="Rotate failed">
              <p>{error}</p>
            </EuiCallOut>
          </>
        )}

        {preview && !error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="success" iconType="check" title="Preview">
              <p>
                Will create <code>{preview.new_repo_name}</code> at{' '}
                <code>{preview.new_bucket}/{preview.new_base_path}</code>.
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
        <EuiButton fill onClick={doRun} iconType="play" isLoading={running} isDisabled={running}>
          Run rotate
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}
