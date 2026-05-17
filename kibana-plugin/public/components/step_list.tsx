import React from 'react';
import { EuiCode } from '@elastic/eui';

/**
 * Common shape of the `steps[]` array on every action result. Each
 * action exports its own narrower union of `type` / `action`, but the
 * scalar render is identical so we share one component.
 */
export interface ActionStep {
  type: string;
  action: string;
  name?: string;
  detail?: string;
}

export function StepList({ steps }: { steps: ActionStep[] }) {
  if (steps.length === 0) {
    return <p>(no steps)</p>;
  }
  return (
    <ul>
      {steps.map((s, i) => (
        <li key={i}>
          <EuiCode>{s.type}</EuiCode>
          {' — '}
          {s.action}
          {s.name ? ` (${s.name})` : ''}
          {s.detail ? ` — ${s.detail}` : ''}
        </li>
      ))}
    </ul>
  );
}
