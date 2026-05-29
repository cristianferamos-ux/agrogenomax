export function FormField({ label, children, required = false }) {
  return (
    <label className="gan-field">
      <span>
        {label}
        {required ? <b>*</b> : null}
      </span>
      {children}
    </label>
  );
}

export function StatusMessage({ type = 'info', children }) {
  if (!children) return null;
  return <div className={`gan-status gan-status-${type}`}>{children}</div>;
}
