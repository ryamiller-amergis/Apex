import React from 'react';
import styles from './LoadTestRawScriptEditor.module.css';

interface LoadTestRawScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  error?: string;
}

const PLACEHOLDER = `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '5m',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(\`\${__ENV.TARGET_URL}/health\`);
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
`;

export const LoadTestRawScriptEditor: React.FC<LoadTestRawScriptEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  error,
}) => {
  return (
    <div className={styles.wrap}>
      <label htmlFor="load-test-raw-script" className={styles.label}>
        k6 script
      </label>
      <textarea
        id="load-test-raw-script"
        className={styles.textarea}
        data-testid="load-test-raw-editor"
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        placeholder={PLACEHOLDER}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'load-test-raw-error' : 'load-test-raw-hint'}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <p id="load-test-raw-hint" className={styles.hint}>
        Edit the k6 script directly, or generate one with AI above. Regenerating from Guided after a
        hand edit will ask for confirmation.
      </p>
      {error && (
        <span id="load-test-raw-error" className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
};

export default LoadTestRawScriptEditor;
