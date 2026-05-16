import React from 'react';
import {
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
} from '@elastic/eui';

/** Centered spinner for first-load page states. */
export function PageLoading() {
  return (
    <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 300 }}>
      <EuiFlexItem grow={false}>
        <EuiLoadingSpinner size="xl" />
      </EuiFlexItem>
    </EuiFlexGroup>
  );
}

interface PageErrorProps {
  message: string;
  onRetry?: () => void;
  title?: string;
}

/** Full-page error with optional retry. Used for first-load failures. */
export function PageError({ message, onRetry, title = 'Failed to load' }: PageErrorProps) {
  return (
    <EuiCallOut title={title} color="danger" iconType="alert">
      <p>{message}</p>
      {onRetry && (
        <EuiButton color="danger" onClick={onRetry}>
          Retry
        </EuiButton>
      )}
    </EuiCallOut>
  );
}
