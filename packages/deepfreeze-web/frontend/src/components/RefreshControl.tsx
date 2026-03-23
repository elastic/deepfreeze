import { useState, useEffect, useCallback, useRef } from 'react';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiButtonEmpty,
  EuiSelect,
  EuiText,
} from '@elastic/eui';

const INTERVAL_OPTIONS = [
  { value: '0', text: 'Off' },
  { value: '15', text: '15 s' },
  { value: '30', text: '30 s' },
  { value: '60', text: '1 min' },
  { value: '120', text: '2 min' },
  { value: '300', text: '5 min' },
  { value: '600', text: '10 min' },
];

interface RefreshControlProps {
  onRefresh: () => void | Promise<void>;
  loading?: boolean;
  defaultInterval?: number; // seconds, 0 = off
}

export default function RefreshControl({
  onRefresh,
  loading = false,
  defaultInterval = 60,
}: RefreshControlProps) {
  const [intervalSec, setIntervalSec] = useState(defaultInterval);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [ago, setAgo] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doRefresh = useCallback(async () => {
    await onRefresh();
    setLastRefresh(new Date());
  }, [onRefresh]);

  // Set up auto-refresh interval
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (intervalSec > 0) {
      timerRef.current = setInterval(doRefresh, intervalSec * 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [intervalSec, doRefresh]);

  // Update "ago" text every 5s
  useEffect(() => {
    const tick = setInterval(() => {
      if (!lastRefresh) return;
      const sec = Math.round((Date.now() - lastRefresh.getTime()) / 1000);
      if (sec < 5) setAgo('just now');
      else if (sec < 60) setAgo(`${sec}s ago`);
      else setAgo(`${Math.floor(sec / 60)}m ago`);
    }, 5000);
    return () => clearInterval(tick);
  }, [lastRefresh]);

  // Initial refresh timestamp
  useEffect(() => {
    setLastRefresh(new Date());
  }, []);

  return (
    <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
      <EuiFlexItem grow={false}>
        <EuiButtonEmpty
          iconType="refresh"
          onClick={doRefresh}
          isLoading={loading}
          size="s"
        >
          Refresh
        </EuiButtonEmpty>
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <EuiSelect
          options={INTERVAL_OPTIONS}
          value={String(intervalSec)}
          onChange={(e) => setIntervalSec(Number(e.target.value))}
          compressed
          prepend="Auto"
          style={{ width: 100 }}
        />
      </EuiFlexItem>
      {ago && (
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">{ago}</EuiText>
        </EuiFlexItem>
      )}
    </EuiFlexGroup>
  );
}
